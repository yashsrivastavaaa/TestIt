import asyncio
import json
import re
from urllib.parse import urlparse
import httpx
from pydantic import ValidationError
from app.groq import generate_text
from app.guardrails import PLANNER_SYSTEM
from app.models import PlannedTest


def _ungrounded_selectors(cases: list[PlannedTest], source: str) -> list[str]:
    unsupported = []
    patterns = (
        r"\[(?:data-testid|aria-label|name|id)\s*=\s*['\"]([^'\"]+)['\"]\s*\]",
        r"#([A-Za-z_][\w-]*)",
        r"\.([A-Za-z_][\w-]*)",
    )
    for case in cases:
        for step in case.steps:
            selector = step.selector or ""
            for pattern in patterns:
                for token in re.findall(pattern, selector, re.IGNORECASE):
                    if token not in source:
                        unsupported.append(f"{case.title}: {selector}")
                        break
                else:
                    continue
                break
            text_values = re.findall(r":has-text\(\s*['\"]([^'\"]+)['\"]\s*\)", selector, re.IGNORECASE)
            if any(value.casefold() not in source.casefold() for value in text_values):
                unsupported.append(f"{case.title}: text selector is absent from source: {selector}")
            if step.action == "assertText" and step.value and step.value.casefold() not in source.casefold():
                unsupported.append(f"{case.title}: asserted text is absent from source: {step.value[:100]}")
    return list(dict.fromkeys(unsupported))


def _known_routes(files: set[str], source: str) -> set[str]:
    routes = set()
    for file_path in files:
        parts = file_path.split("/")
        root_index = next((index for index, part in enumerate(parts) if part in {"app", "pages"}), None)
        if root_index is None:
            continue
        root = parts[root_index]
        relative = parts[root_index + 1:]
        leaf = relative[-1] if relative else ""
        suffix = leaf.rsplit(".", 1)[-1].lower() if "." in leaf else ""
        if root == "app" and leaf.startswith("page."):
            segments = relative[:-1]
            segments = [segment for segment in segments if not (segment.startswith("(") and segment.endswith(")")) and not segment.startswith("@")]
            routes.add("/" + "/".join(segments) if segments else "/")
        elif root == "app" and leaf == "route.ts":
            segments = relative[:-1]
            routes.add("/" + "/".join(segments))
        elif root == "pages" and suffix in {"tsx", "ts", "jsx", "js"}:
            segments = relative[:-1] if leaf.startswith("index.") else relative
            if segments and not leaf.startswith("index."):
                segments[-1] = segments[-1].rsplit(".", 1)[0]
            if segments and segments[0] == "api":
                routes.add("/api/" + "/".join(segments[1:]))
            else:
                routes.add("/" + "/".join(segments) if segments else "/")
    # Literal hrefs and route strings in source also provide direct evidence.
    routes.update(re.findall(r"(?:href|push|replace|targetRoute)\s*[:=(]\s*[`'\"](/[^'\"`?#]*)", source))
    return routes


def _route_is_known(target: str, known_routes: set[str]) -> bool:
    if target in known_routes:
        return True
    for route in known_routes:
        # A concrete path may match Next.js dynamic segments such as [id],
        # [...slug], and [[...slug]].
        pattern = re.escape(route)
        pattern = re.sub(r"\\\[\\\[\\\.\\\.\\\.([^]]+)\\\]\\\]", r".+", pattern)
        pattern = re.sub(r"\\\[\\\.\\\.\\\.([^]]+)\\\]", r".+", pattern)
        pattern = re.sub(r"\\\[([^]]+)\\\]", r"[^/]+", pattern)
        if re.fullmatch(pattern, target):
            return True
    return False


def _metadata_issues(cases: list[PlannedTest], source: str, changed_files: set[str]) -> list[str]:
    allowed_types = {"ui", "auth", "api", "form", "integration", "edge-case"}
    available_files = set(re.findall(r"(?m)^FILE (.+)$", source))
    known_routes = _known_routes(available_files, source)
    issues = []
    for case in cases:
        case.description = " ".join(case.description.split())
        if case.type not in allowed_types:
            issues.append(f"{case.title}: invalid type {case.type!r}")
        if case.priority not in {"low", "medium", "high"}:
            issues.append(f"{case.title}: invalid priority {case.priority!r}")
        if not case.target_route.startswith("/") or "://" in case.target_route:
            issues.append(f"{case.title}: targetRoute must be an app path beginning with /")
        elif not _route_is_known(case.target_route, known_routes):
            issues.append(f"{case.title}: targetRoute must map to a route file or literal route present in Repository File Context; known routes: {sorted(known_routes)[:30]}")
        if not case.expected_result.strip():
            issues.append(f"{case.title}: expectedResult is missing")
        if len(case.steps) > 10:
            issues.append(f"{case.title}: plans are limited to 10 steps")
        for step in case.steps:
            if step.action == "click" and re.search(r"\b(delete|remove|destroy|purchase|pay|checkout|cancel subscription|drop table|reset data)\b", f"{step.selector or ''} {step.value or ''}", re.IGNORECASE):
                issues.append(f"{case.title}: destructive or financial actions are not allowed in generated tests")
        invalid_files = [path for path in case.target_files if path not in available_files]
        if not case.target_files or invalid_files:
            issues.append(f"{case.title}: targetFiles must list existing paths from Repository File Context; invalid paths: {invalid_files}")
        elif changed_files and not changed_files.intersection(case.target_files):
            issues.append(f"{case.title}: targetFiles must include at least one relevant path from Changed source files: {sorted(changed_files)}")
    return issues


def _normalize_navigation(cases: list[PlannedTest], application_url: str) -> None:
    for case in cases:
        for step in case.steps:
            if step.action == "navigate" and (not step.value or "replace-with-your-app-url" in step.value):
                step.value = application_url


def _navigation_issues(cases: list[PlannedTest], application_url: str) -> list[str]:
    try:
        base = urlparse(application_url)
        base_origin = (base.scheme, base.hostname, base.port)
    except ValueError:
        return ["Configured application URL is invalid"]
    issues = []
    for case in cases:
        for step in case.steps:
            if step.action != "navigate":
                continue
            try:
                target = urlparse(step.value or "")
                target_origin = (target.scheme, target.hostname, target.port)
                safe = target.scheme in {"http", "https"} and target_origin == base_origin and not target.username and not target.password
            except ValueError:
                safe = False
            if not safe:
                issues.append(f"{case.title}: navigation must stay on the configured application origin")
    return issues


async def plan_tests(api_key: str, repository: str, branch: str, commit: str, changes: str, changed_files: list[str], source: str, application_url: str, feature_prompt: str, test_case_count: int) -> list[PlannedTest]:
    owner, _, repo_name = repository.partition("/")
    repo_name = repo_name or repository
    def build_prompt(source_excerpt: str) -> str:
        return f"""You are an expert QA automation engineer acting as TestIt's Planner Agent. Inspect the supplied changed files, diffs, and current source, then generate at most {test_case_count} useful, small test cases that can run as Playwright/Browserbase automation. Do not fill the requested count with guesses: return only cases directly supported by the supplied repository evidence. Prioritize behavior changed in this commit; use unchanged files only to understand how changed code is reached. When no changed files are available, derive cases from concrete implemented behavior in the current source. Never invent pages, controls, validation rules, login flows, data, API contracts, or success states.

Repository metadata:
Owner: {owner}
Repo: {repo_name}
Branch: {branch}

Each case must include: title (clear), description (exactly one concise line grounded in the implementation), type (one of ui, auth, api, form, integration, edge-case), priority (low, medium, high), targetRoute (a route/page evidenced by source; infer Next.js routes only from supplied app/page or pages paths), targetFiles (only exact paths present in Repository File Context), and expectedResult (an observable passing outcome established by the code). Select targetFiles that directly support the tested behavior. When Changed source files is non-empty, every case must include at least one relevant changed path in targetFiles and test the behavior altered by that file. Never list paths absent from the supplied context. Use `/` only when the root page is actually being tested; API tests may use an evidenced `/api/...` route.

Write ordered steps as executable Playwright plans, not vague descriptions. Start with setViewport when the feature depends on a viewport, then navigate to the exact application URL plus targetRoute. Use exact labels, hrefs, placeholders, accessible names, IDs, classes, names, and test IDs found in the supplied source. Never guess selectors such as data-testid='login-button'. Keep selectors specific; when responsive layouts render duplicate desktop/mobile controls, rely on visible-match selection or provide comma-separated selector alternatives only when each alternative is evidenced in source. Before interacting, target an element expected to be visible and enabled. Playwright actions already wait and scroll controls into view; do not use force clicks or DOM-dispatched clicks. Add assertText steps to verify expectedResult using an evidenced, visible outcome. Use wait only for a real asynchronous transition; avoid arbitrary delays and swallowed assertion errors. Avoid destructive actions and fabricated input data.

Keep each case to at most 10 browser steps. For responsive/mobile behavior, infer the breakpoint and set a phone viewport before navigation (for example, 390x844). For flows requiring authentication or data that is not available in source, state the precondition in the description and do not invent credentials or setup.

Ground every test description in code: mention the relevant source path(s) and briefly state the behavior those files establish. If the requested feature is not evidenced by the repository source, say so in the description and create tests for the closest evidenced behavior instead of inventing implementation details. If this is a no-change analysis, do not describe tests as covering newly changed behavior.

Return only valid JSON exactly as {{"test_cases":[{{"title":"...","description":"one concise line","type":"ui|auth|api|form|integration|edge-case","priority":"low|medium|high","targetRoute":"/route","targetFiles":["path/from/context"],"expectedResult":"observable passing outcome","steps":[{{"action":"setViewport|navigate|click|fill|assertText|wait","selector":"CSS selector when required","value":"URL/text/input/wait duration or WIDTHxHEIGHT viewport"}}]}}]}}. Return fewer than {test_case_count} cases, or an empty array, when the repository evidence does not support more. Use this exact website URL as the base for navigation steps: {application_url}. Never output placeholder URLs, Markdown, or code to execute.

Repository: {repository}
Commit: {commit}
Feature or behavior the user wants tested:
{(feature_prompt or "No specific feature requested; prioritize relevant repository changes and core user journeys.")[:2000]}
Changed source files (all returned cases must be grounded in these when any are listed):
{json.dumps(changed_files)}
Change summary:
{changes[:3000]}

Repository source excerpts:
{source_excerpt}"""

    async def generate_plan(prompt: str, max_tokens: int):
        try:
            return await asyncio.to_thread(
                generate_text,
                contents=prompt,
                system=PLANNER_SYSTEM,
                api_key=api_key,
                json_mode=True,
                temperature=0.1,
                max_tokens=max_tokens,
            )
        except httpx.HTTPStatusError as error:
            # Groq's JSON constrained generation can reject an otherwise
            # useful model response. Retry once without constrained decoding;
            # parse and validate the returned JSON locally before saving it.
            message = str(error).lower()
            is_json_generation_rejection = (
                "json" in message
                and (
                    "failed to generate" in message
                    or "failed to validate" in message
                    or "failed_generation" in message
                )
            )
            if error.response.status_code != 400 or not is_json_generation_rejection:
                raise
            retry_prompt = prompt + "\n\nOutput exactly one complete JSON object. Do not use Markdown fences or add commentary. Ensure every string is escaped and the JSON ends with a closing brace."
            return await asyncio.to_thread(
                generate_text,
                contents=retry_prompt,
                system=PLANNER_SYSTEM,
                api_key=api_key,
                json_mode=False,
                temperature=0,
                max_tokens=max_tokens,
            )

    response = None
    budgets = list(dict.fromkeys((min(len(source), 12_000), min(len(source), 6_000), min(len(source), 2_500))))
    for source_budget in budgets:
        try:
            response = await generate_plan(
                build_prompt(source[:source_budget]),
                min(4096, max(1400, test_case_count * 650)),
            )
            break
        except httpx.HTTPStatusError as error:
            if error.response.status_code != 413 or source_budget == budgets[-1]:
                if error.response.status_code == 413:
                    raise ValueError("Groq rejected the planner request as too large. Reduce the feature prompt or source size and try again.") from error
                raise
    if response is None:
        raise ValueError("Planner could not create a request from the repository source.")
    def parse_cases(text: str) -> list[PlannedTest]:
        raw = None
        try:
            raw = json.loads(text or "")
        except json.JSONDecodeError:
            decoder = json.JSONDecoder()
            for offset, char in enumerate(text or ""):
                if char != "{":
                    continue
                try:
                    candidate, _ = decoder.raw_decode(text[offset:])
                    if isinstance(candidate, dict) and ("test_cases" in candidate or "testCases" in candidate):
                        raw = candidate
                        break
                except json.JSONDecodeError:
                    continue
        try:
            if not isinstance(raw, dict):
                raise TypeError("Expected a JSON object")
            candidates = raw.get("test_cases", raw.get("testCases", []))
            if not isinstance(candidates, list):
                raise TypeError("test_cases must be an array")
            return [PlannedTest.model_validate(item) for item in candidates[:test_case_count]]
        except (TypeError, ValidationError) as error:
            raise ValueError("Planner Agent returned an invalid test plan. Try analysis again.") from error

    cases = parse_cases(response.text or "")
    if not cases:
        # An empty result can be a conservative model miss when source excerpts
        # are noisy. Ask once with a narrower objective; the retry still has to
        # ground every route, file, selector, and assertion in the same source.
        focused_prompt = build_prompt(source[:source_budget]) + (
            "\n\nThe previous response returned no test cases. Reinspect the supplied source excerpts and identify "
            "the single clearest implemented user-visible or API behavior that can be tested from this evidence. "
            "Return one small case if and only if the source supports its route, target file, actions, and passing "
            "outcome. Prefer a read-only UI/API check. Do not require credentials or fabricate setup data. "
            "Return an empty array only if the supplied code truly contains no runnable, evidenced behavior."
        )
        try:
            focused_response = await generate_plan(
                focused_prompt,
                min(4096, max(1400, test_case_count * 650)),
            )
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 413:
                raise ValueError("Groq rejected the focused planner request as too large. Reduce the feature prompt or retry analysis.") from error
            raise
        cases = parse_cases(focused_response.text or "")
    if not cases:
        source_files = re.findall(r"(?m)^FILE (.+)$", source)
        evidence_hint = ", ".join(source_files[:6]) or "no readable source paths"
        raise ValueError(
            "The planner could not identify a runnable behavior from the supplied repository source "
            f"({evidence_hint}). Choose a feature implemented in those files or include the relevant route/component source."
        )
    _normalize_navigation(cases, application_url)
    planner_source = source[:source_budget]
    available_source_files = set(re.findall(r"(?m)^FILE (.+)$", planner_source))
    grounded_changed_files = set(changed_files).intersection(available_source_files)
    issues = _metadata_issues(cases, planner_source, grounded_changed_files) + _ungrounded_selectors(cases, planner_source) + _navigation_issues(cases, application_url)
    if issues:
        correction = "\n\nPlan validation failed: " + json.dumps(issues[:20]) + ". Correct every listed issue. targetFiles must exactly match FILE paths in Repository File Context. Routes must map to a supplied route file or literal route. Every selector and assertText value must be evidenced in supplied source. Navigation must stay on the configured application origin. Do not include destructive or financial actions. Use allowed type and priority values, a non-empty expectedResult, and a one-line description. Return the full corrected JSON test plan."
        try:
            corrected = await generate_plan(
                build_prompt(source[:source_budget]) + correction,
                min(4096, max(1400, test_case_count * 650)),
            )
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 413:
                raise ValueError("Groq rejected the selector-correction request as too large. Reduce the feature prompt or retry analysis.") from error
            raise
        cases = parse_cases(corrected.text or "")
        _normalize_navigation(cases, application_url)
        remaining_issues = _metadata_issues(cases, planner_source, grounded_changed_files) + _ungrounded_selectors(cases, planner_source) + _navigation_issues(cases, application_url)
        if remaining_issues:
            raise ValueError("Planner returned invalid metadata or selectors after a correction attempt: " + "; ".join(remaining_issues[:4]))
    if len(cases) > test_case_count:
        cases = cases[:test_case_count]
    return cases
