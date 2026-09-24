type BrowserStep = { action: string; value?: string; selector?: string };

export function renderBrowserScript(title: string, steps: BrowserStep[]) {
  const actions = steps.map((step, index) => {
    if (step.action === "setViewport") {
      const match = /^(\d{2,4})\s*[x,]\s*(\d{2,4})$/i.exec(step.value || "");
      return match
        ? `  console.log(${JSON.stringify(`Set viewport to ${match[1]}x${match[2]}`)});\n  await page.setViewportSize({ width: ${Number(match[1])}, height: ${Number(match[2])} });`
        : `  throw new Error("Set viewport using WIDTHxHEIGHT, for example 390x844.");`;
    }
    if (step.action === "navigate") return step.value
      ? `  console.log(${JSON.stringify(`Navigate to ${step.value}`)});\n  await page.goto(${JSON.stringify(step.value)}, { waitUntil: "domcontentloaded" });`
      : `  throw new Error("Add a website URL before running this browser script.");`;
    if (step.action === "wait") return `  console.log(${JSON.stringify(`Wait ${Math.min(Math.max(Number(step.value) || 500, 100), 5000)}ms`)});\n  await page.waitForTimeout(${Math.min(Math.max(Number(step.value) || 500, 100), 5000)});`;

    const selector = JSON.stringify(step.selector || "body");
    if (step.action === "click") return `  console.log(${JSON.stringify(`Click visible element ${step.selector || "body"}`)});\n  const clickTarget${index} = await visibleMatch(${selector});\n  await clickTarget${index}.waitFor({ state: "visible", timeout: 4000 });\n  await clickTarget${index}.scrollIntoViewIfNeeded();\n  await clickTarget${index}.click({ timeout: 15000 });`;
    if (step.action === "fill") return `  console.log(${JSON.stringify(`Fill visible element ${step.selector || "body"}`)});\n  const fillTarget${index} = await visibleMatch(${selector});\n  await fillTarget${index}.waitFor({ state: "visible", timeout: 4000 });\n  await fillTarget${index}.scrollIntoViewIfNeeded();\n  await fillTarget${index}.fill(${JSON.stringify(step.value || "")});`;
    if (step.action === "assertText") return `  console.log(${JSON.stringify(`Assert visible text: ${step.value || ""}`)});\n  const assertionTarget${index} = await visibleMatch(${selector});\n  const expectedText${index} = assertionTarget${index}.getByText(${JSON.stringify(step.value || "")}, { exact: false });\n  await expectedText${index}.waitFor({ state: "visible", timeout: 15000 });\n  assert(await expectedText${index}.isVisible(), ${JSON.stringify(`Expected visible text: ${step.value || ""}`)});`;
    return "";
  }).filter(Boolean).join("\n");

  return `// ${title}\n// Playwright script body. Pass an open Playwright Page to runTest.\nfunction assert(condition, message = "Assertion failed") {\n  if (!condition) throw new Error(message);\n}\n\nasync function visibleMatch(page, selector) {\n  const matches = page.locator(selector);\n  for (let index = 0; index < await matches.count(); index++) {\n    const candidate = matches.nth(index);\n    if (await candidate.isVisible()) return candidate;\n  }\n  return matches.first();\n}\n\nasync function runTest(page, console) {\n  console.log(${JSON.stringify(`Running: ${title}`)});\n${actions}\n}\n\n// Usage: await runTest(page, console);`;
}

// Keep the old export name during migration; the generated script is now
// provider-neutral and runs against an already-open local Playwright page.
export const renderBrowserbaseScript = renderBrowserScript;
