import asyncio
import ipaddress
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx
from playwright.sync_api import Browser, sync_playwright

from app.models import PlannedTest
from app.security import redact_repository_content

_BROWSERBASE_API = "https://api.browserbase.com/v1"


class BrowserbaseServiceError(RuntimeError):
    """A provider/setup failure that is not caused by the test or page."""


def _browserbase_error(action: str, response: httpx.Response) -> BrowserbaseServiceError:
    message = ""
    try:
        payload = response.json()
        if isinstance(payload, dict):
            message = str(payload.get("message") or payload.get("error") or "")[:250]
    except ValueError:
        message = response.text[:250]
    detail = f"{action} ({response.status_code})"
    if message:
        detail += f": {message}"
    return BrowserbaseServiceError(detail)


def _valid_target_url(value: str, allow_local: bool) -> bool:
    try:
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return False
        host = parsed.hostname.lower().rstrip(".")
        if allow_local and host in {"localhost", "127.0.0.1", "::1"}:
            return True
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            return False
        try:
            address = ipaddress.ip_address(host)
            return address.is_global
        except ValueError:
            return "." in host and not host.endswith((".test", ".invalid"))
    except ValueError:
        return False


def _visible_match(page, selector: str):
    matches = page.locator(selector)
    for index in range(matches.count()):
        candidate = matches.nth(index)
        if candidate.is_visible():
            return candidate
    # Keep Playwright's normal timeout and useful locator error when nothing
    # is visible yet or the selector does not match anything.
    return matches.first


def _execute_steps(browser: Browser, case: PlannedTest, *, allow_local: bool, engine: str, inspection_delay_ms: int = 0) -> dict:
    report = {"passed": False, "details": "Browser execution did not complete.", "ranAt": datetime.now(timezone.utc).isoformat(), "engine": engine, "stepResults": []}
    page = None
    test_origin = None
    try:
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(15000)
        for index, step in enumerate(case.steps):
            report["failedStep"] = index + 1
            safe_value = step.value
            if step.action == "fill" and re.search(r"password|passcode|secret|token|api[_-]?key|card|cvv|ssn", step.selector or "", re.IGNORECASE):
                safe_value = "[REDACTED]"
            elif safe_value:
                safe_value = redact_repository_content(safe_value)
            step_result = {"index": index + 1, "action": step.action, "selector": step.selector, "value": safe_value, "status": "running"}
            report["stepResults"].append(step_result)
            if step.action == "setViewport":
                match = re.fullmatch(r"\s*(\d{2,4})\s*[x,]\s*(\d{2,4})\s*", step.value or "", re.IGNORECASE)
                if not match:
                    raise ValueError(f"Step {index + 1} needs a viewport in WIDTHxHEIGHT format, for example 390x844.")
                width, height = (int(value) for value in match.groups())
                if not 240 <= width <= 3840 or not 320 <= height <= 3840:
                    raise ValueError("Viewport dimensions must be between 240x320 and 3840x3840.")
                page.set_viewport_size({"width": width, "height": height})
            elif step.action == "navigate":
                target = step.value or ""
                if not _valid_target_url(target, allow_local):
                    scope = "http or https URL" if allow_local else "public http or https URL"
                    raise ValueError(f"Navigation steps must use a {scope}.")
                parsed_target = urlparse(target)
                target_origin = (parsed_target.scheme, parsed_target.hostname, parsed_target.port)
                if test_origin is not None and target_origin != test_origin:
                    raise ValueError("Navigation steps must stay on the same website being tested.")
                test_origin = target_origin
                page.goto(target, wait_until="domcontentloaded", timeout=30000)
            elif step.action == "wait":
                try:
                    delay = int(step.value or "500")
                except ValueError:
                    delay = 500
                page.wait_for_timeout(min(max(delay, 100), 5000))
            else:
                if not step.selector:
                    raise ValueError(f"Step {index + 1} is missing a CSS selector.")
                locator = _visible_match(page, step.selector)
                if step.action == "click":
                    locator.click()
                elif step.action == "fill":
                    locator.fill(step.value or "")
                elif step.action == "assertText":
                    locator.get_by_text(step.value or "", exact=False).wait_for(state="visible")
            step_result["status"] = "passed"
        report["passed"] = True
        report["details"] = f"All {len(case.steps)} steps completed successfully in {engine}."
        report.pop("failedStep", None)
    except Exception as error:
        report["details"] = str(error)[:500]
        if report["stepResults"] and report["stepResults"][-1]["status"] == "running":
            report["stepResults"][-1]["status"] = "failed"
            report["stepResults"][-1]["error"] = str(error)[:350]
        try:
            report["currentUrl"] = page.url
        except Exception:
            pass
        try:
            report["viewport"] = page.evaluate("() => ({ width: window.innerWidth, height: window.innerHeight })")
        except Exception:
            pass
        try:
            elements = page.locator("button,a,input,select,textarea,[role='button'],[role='link']").evaluate_all("""nodes => nodes.filter(el => {
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            }).slice(0, 30).map(el => ({
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 100),
              testId: el.getAttribute('data-testid'),
              id: el.id || null,
              className: typeof el.className === 'string' ? el.className : null,
              ariaLabel: el.getAttribute('aria-label'),
              name: el.getAttribute('name'),
              role: el.getAttribute('role')
            }))""")
            for element in elements:
                for key, value in element.items():
                    if isinstance(value, str):
                        element[key] = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", value)
            report["pageElements"] = elements
        except Exception:
            report["pageElements"] = []
    if inspection_delay_ms and page:
        try:
            page.wait_for_timeout(inspection_delay_ms)
        except Exception:
            pass
    return report


def _run_local(case: PlannedTest, show_browser: bool = False) -> dict:
    with sync_playwright() as playwright:
        executable = Path(playwright.chromium.executable_path)
        if not executable.is_file():
            raise RuntimeError("Chromium is not installed for this Python environment.")
        try:
            browser = playwright.chromium.launch(
                headless=not show_browser,
                slow_mo=350 if show_browser else 0,
                args=["--start-maximized"] if show_browser else [],
            )
        except Exception as error:
            raise RuntimeError(f"Chromium could not launch ({str(error)[:250]}). Install the browser dependencies and retry.") from error
        try:
            return _execute_steps(
                browser,
                case,
                allow_local=True,
                engine="Local Playwright",
                inspection_delay_ms=5000 if show_browser else 0,
            )
        finally:
            try:
                browser.close()
            except Exception:
                # Browser shutdown can report a closed driver after a launch or
                # page failure. Preserve the actionable original run result.
                pass


def _run_remote(connect_url: str, case: PlannedTest) -> dict:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(connect_url, timeout=30000)
        try:
            return _execute_steps(browser, case, allow_local=False, engine="Browserbase")
        finally:
            browser.close()


def _validate_case(case: PlannedTest) -> dict | None:
    if not case.steps or len(case.steps) > 30:
        return {"passed": False, "details": "A browser test must contain between 1 and 30 steps.", "ranAt": datetime.now(timezone.utc).isoformat()}
    destructive = re.compile(r"\b(delete|remove|destroy|purchase|pay|checkout|cancel subscription|drop table|reset data)\b", re.IGNORECASE)
    if any(step.action in {"click", "fill"} and destructive.search(f"{step.selector or ''} {step.value or ''}") for step in case.steps):
        return {"passed": False, "errorCode": "UNSAFE_TEST_ACTION", "details": "This test contains a potentially destructive or financial interaction. Remove it or rewrite the case to verify a safe confirmation state.", "ranAt": datetime.now(timezone.utc).isoformat()}
    return None


async def execute_local(case: PlannedTest, show_browser: bool = False) -> dict:
    invalid = _validate_case(case)
    if invalid:
        return invalid
    try:
        return await asyncio.to_thread(_run_local, case, show_browser)
    except Exception as error:
        return {
            "passed": False,
            "errorCode": "LOCAL_CHROMIUM_UNAVAILABLE",
            "details": fr"Local browser setup is unavailable: {str(error)[:350]} From the agent_service folder, run `.\.venv\Scripts\python.exe -m playwright install chromium` using the same environment that runs this service, then restart it. Or enable the Browserbase option.",
            "ranAt": datetime.now(timezone.utc).isoformat(),
            "engine": "Local Playwright",
        }


async def execute_browserbase(api_key: str, case: PlannedTest) -> dict:
    invalid = _validate_case(case)
    if invalid:
        return invalid
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            headers = {"X-BB-API-Key": api_key, "content-type": "application/json"}
            projects_response = await client.get(f"{_BROWSERBASE_API}/projects", headers=headers)
            if not projects_response.is_success:
                raise _browserbase_error("Could not list Browserbase projects", projects_response)
            projects_payload = projects_response.json()
            projects = projects_payload if isinstance(projects_payload, list) else projects_payload.get("projects", [])
            if not projects:
                raise BrowserbaseServiceError("No projects are available to this Browserbase API key.")
            project_id = projects[0].get("id")
            if not project_id:
                raise BrowserbaseServiceError("Browserbase did not return a project ID.")
            response = await client.post(f"{_BROWSERBASE_API}/sessions", headers=headers, json={"projectId": project_id, "keepAlive": True})
            if not response.is_success:
                raise _browserbase_error("Could not create a Browserbase session", response)
            session = response.json()
            session_id = session.get("id")
            connect_url = session.get("connectUrl") or session.get("connect_url")
            if not session_id or not connect_url:
                raise BrowserbaseServiceError("Browserbase did not return a session ID and CDP connection URL.")
            live_view_url = None
            try:
                debug_response = await client.get(f"{_BROWSERBASE_API}/sessions/{session_id}/debug", headers=headers)
                if debug_response.is_success:
                    live_view_url = debug_response.json().get("debuggerFullscreenUrl")
            except (httpx.HTTPError, ValueError):
                pass
            try:
                report = await asyncio.to_thread(_run_remote, connect_url, case)
            except Exception as error:
                raise BrowserbaseServiceError(f"Could not connect to the Browserbase browser session: {str(error)[:250]}") from error
            report["sessionId"] = session_id
            if live_view_url:
                report["liveViewUrl"] = live_view_url
            return report
    except BrowserbaseServiceError as error:
        return {
            "passed": False,
            "errorCode": "BROWSERBASE_UNAVAILABLE",
            "details": f"Browserbase setup failed before the test started: {error}. Verify BROWSERBASE_API_KEY and project access in agent_service/.env, then retry.",
            "ranAt": datetime.now(timezone.utc).isoformat(),
            "engine": "Browserbase",
        }
    except httpx.HTTPError as error:
        return {
            "passed": False,
            "errorCode": "BROWSERBASE_UNAVAILABLE",
            "details": f"Could not reach the Browserbase API: {str(error)[:300]}. Check connectivity and BROWSERBASE_API_KEY in agent_service/.env, then retry.",
            "ranAt": datetime.now(timezone.utc).isoformat(),
            "engine": "Browserbase",
        }
