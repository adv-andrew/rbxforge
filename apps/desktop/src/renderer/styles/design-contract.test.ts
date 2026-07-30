// @vitest-environment jsdom

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postcss, { type Declaration } from "postcss";
import { describe, expect, it } from "vitest";

const rendererRoot = resolve(import.meta.dirname, "..");
const stylesRoot = resolve(rendererRoot, "styles");
const desktopRoot = resolve(rendererRoot, "../..");

async function cssFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return cssFiles(path);
      return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function parsedCss() {
  return Promise.all(
    (await cssFiles(rendererRoot)).map(async (file) => ({
      file,
      root: postcss.parse(await readFile(file, "utf8"), { from: file }),
    })),
  );
}

function cssContractViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const root = postcss.parse(source, { from: file });
  const allowedShadows = new Map([
    ["components/shared/Dialog.module.css", new Set([".dialogPanel"])],
    ["components/shared/Menu.module.css", new Set([".menu"])],
    ["components/shared/Sheet.module.css", new Set([".sheet"])],
  ]);
  const normalizedFile = file.replaceAll("\\", "/");

  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === "import") violations.push("imports are forbidden");
    if (/url\s*\(/i.test(atRule.params)) violations.push("URLs are forbidden");
  });

  root.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const value = declaration.value.toLowerCase();
    if (/url\s*\(/.test(value)) violations.push("URLs are forbidden");
    if (/(?:^|[-\w])gradient\s*\(/.test(value)) violations.push("gradients are forbidden");
    if (property === "backdrop-filter" || property === "-webkit-backdrop-filter") {
      violations.push("backdrop filters are forbidden");
    }
    if ((property === "filter" || property === "-webkit-filter") && value.trim() !== "none") {
      violations.push("filters are forbidden");
    }
    if (property === "transition-property" || property === "-webkit-transition-property") {
      const properties = value.split(",").map((part) => part.trim());
      if (properties.some((transitioned) => !["opacity", "transform", "none"].includes(transitioned))) {
        violations.push("non-compositor transition");
      }
    }
    if (property === "transition" || property === "-webkit-transition") {
      const timingKeywords = new Set([
        "ease",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "linear",
        "step-start",
        "step-end",
        "normal",
        "allow-discrete",
      ]);
      const invalid = value.split(",").some((transition) => {
        const withoutFunctions = transition.replace(/\b(?:var|cubic-bezier|steps|linear)\([^)]*\)/g, " ");
        const withoutTimes = withoutFunctions.replace(/\b-?(?:\d*\.)?\d+m?s\b/g, " ");
        const identifiers = withoutTimes.match(/-?[_a-z][_a-z0-9-]*/g) ?? [];
        const properties = identifiers.filter((identifier) => !timingKeywords.has(identifier));
        return properties.length !== 1 || !["opacity", "transform"].includes(properties[0]!);
      });
      if (invalid) violations.push("non-compositor transition");
    }

    let ancestor = declaration.parent;
    while (ancestor && ancestor.type !== "root") {
      if (
        ancestor.type === "atrule" &&
        ancestor.name.toLowerCase().endsWith("keyframes") &&
        !["opacity", "transform"].includes(property)
      ) {
        violations.push("non-compositor keyframe");
        break;
      }
      ancestor = ancestor.parent;
    }

    if (property === "text-shadow" && value.trim() !== "none") {
      violations.push("non-overlay shadow");
    }
    if (property === "box-shadow" && value.trim() !== "none") {
      const selector = declaration.parent?.type === "rule" ? declaration.parent.selector : "";
      const allowed = [...allowedShadows].some(
        ([suffix, selectors]) => normalizedFile.endsWith(suffix) && selectors.has(selector),
      );
      if (!allowed) violations.push("non-overlay shadow");
    }
  });
  return violations;
}

describe("desktop design contracts", () => {
  it("pins PostCSS directly for parsed renderer contracts", async () => {
    const packageJson = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(packageJson.devDependencies.postcss).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("declares the approved token values", async () => {
    const css = await readFile(resolve(stylesRoot, "tokens.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const values = getComputedStyle(document.documentElement);
    expect(values.getPropertyValue("--color-canvas").trim()).toBe("#0b0d10");
    expect(values.getPropertyValue("--color-sidebar").trim()).toBe("#0f1217");
    expect(values.getPropertyValue("--color-brand-red").trim()).toBe("#c4281c");
    expect(values.getPropertyValue("--color-brand-red-hover").trim()).toBe("#d43a2e");
    expect(values.getPropertyValue("--color-focus").trim()).toBe("#f06458");
    expect(values.getPropertyValue("--space-1").trim()).toBe("4px");
    expect(values.getPropertyValue("--duration-fast").trim()).toBe("120ms");
    expect(values.getPropertyValue("--duration-standard").trim()).toBe("180ms");
    style.remove();
  });

  it("resolves every token reference and keeps raw colors in the token sheet", async () => {
    const files = await parsedCss();
    const declarations = files.flatMap(({ root }) =>
      root.nodes.flatMap(() => {
        const result: Declaration[] = [];
        root.walkDecls((declaration) => result.push(declaration));
        return result;
      }),
    );
    const declared = new Set(declarations.filter(({ prop }) => prop.startsWith("--")).map(({ prop }) => prop));
    for (const { file, root } of files) {
      root.walkDecls((declaration) => {
        for (const match of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
          if (
            match[1] === "--sidebar-width" &&
            file.replaceAll("\\", "/").endsWith("components/AppShell/AppShell.module.css")
          ) {
            continue;
          }
          expect(declared, `${file}: unresolved ${match[1]}`).toContain(match[1]);
        }
        if (!file.endsWith("tokens.css")) {
          expect(declaration.value, `${file}: raw color`).not.toMatch(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i);
        }
      });
    }
  });

  it("allows only opacity and transform motion and overlay shadows", async () => {
    for (const { file, root } of await parsedCss()) {
      expect(cssContractViolations(file, root.toString()), file).toEqual([]);
      root.walkDecls((declaration) => {
        const value = declaration.value.toLowerCase();
        if (/^(?:animation|transition)(?:-duration)?$/.test(declaration.prop)) {
          const values = value.match(/\b[\d.]+m?s\b/g) ?? [];
          expect(
            values.every((duration) => duration === "0.01ms"),
            `${file}: literal motion duration`,
          ).toBe(true);
        }
      });
    }
  });

  it("reserves connection red for the exact section-label keyline instead of step-marker fill", async () => {
    const css = await readFile(resolve(rendererRoot, "components/ConnectionSheet/ConnectionSheet.module.css"), "utf8");
    const root = postcss.parse(css);
    const marker = root.nodes.find((node) => node.type === "rule" && node.selector === ".marker");
    const keyline = root.nodes.find((node) => node.type === "rule" && node.selector === ".step h3::after");
    expect(marker?.toString()).not.toContain("background: var(--color-brand-red)");
    expect(keyline?.toString()).toContain("background: var(--color-brand-red)");
    expect(keyline?.toString()).toContain("height: 2px");
    expect(keyline?.toString()).toContain("width: 12px");
  });

  it.each([
    ["remote import", '@import url("https://example.test/theme.css");', "imports are forbidden"],
    ["local import", '@import "./tokens.css";', "imports are forbidden"],
    ["remote image", '.card { background-image: url("https://example.test/card.png"); }', "URLs are forbidden"],
    [
      "vendor gradient",
      ".card { background: -webkit-gradient(linear, left top, right top); }",
      "gradients are forbidden",
    ],
    ["backdrop filter", ".card { backdrop-filter: none; }", "backdrop filters are forbidden"],
    ["regular filter", ".card { filter: sepia(1); }", "filters are forbidden"],
    ["transition property", ".card { transition-property: color, opacity; }", "non-compositor transition"],
    ["transition property all", ".card { transition-property: all; }", "non-compositor transition"],
    ["vendor transition", ".card { -webkit-transition: color 120ms ease; }", "non-compositor transition"],
    ["transition shorthand", ".card { transition: color 120ms ease; }", "non-compositor transition"],
    ["keyframe width", "@keyframes grow { from { opacity: 0; } to { width: 100%; } }", "non-compositor keyframe"],
    ["shadow selector substring", ".notASheetCard { box-shadow: var(--shadow-overlay); }", "non-overlay shadow"],
  ])("rejects malicious CSS fixture: %s", (_name, css, expectedViolation) => {
    expect(cssContractViolations("malicious-fixture.css", css)).toContain(expectedViolation);
  });

  it("accepts safe media, keyframe, filter, and transition declarations", () => {
    const css = `
      @media (prefers-reduced-motion: reduce) {
        .item { filter: none; transition: opacity var(--duration-fast), transform var(--duration-standard); }
      }
      @keyframes enter { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
    `;
    expect(cssContractViolations("safe-fixture.css", css)).toEqual([]);
  });

  it("keeps normal button text off the hover and danger fills", async () => {
    for (const { file, root } of await parsedCss()) {
      root.walkDecls((declaration) => {
        if (declaration.prop === "background" || declaration.prop === "background-color") {
          expect(declaration.value, `${file}: hover red used as a normal-text fill`).not.toBe(
            "var(--color-brand-red-hover)",
          );
          expect(declaration.value, `${file}: danger used as a normal-text fill`).not.toBe("var(--color-danger)");
        }
      });
    }
  });

  it("keeps disabled primary actions neutral instead of spending active connection red", async () => {
    const file = resolve(rendererRoot, "components/shared/Button.module.css");
    const root = postcss.parse(await readFile(file, "utf8"), { from: file });
    const disabledPrimary = root.nodes.find(
      (node) =>
        node.type === "rule" &&
        node.selector.includes(".primary:disabled") &&
        node.selector.includes('.primary[aria-disabled="true"]'),
    );
    expect(disabledPrimary?.toString()).toContain("background: var(--color-raised)");
    expect(disabledPrimary?.toString()).toContain("border-color: var(--color-border)");
    expect(disabledPrimary?.toString()).toContain("color: var(--color-text-secondary)");
    expect(disabledPrimary?.toString()).not.toContain("var(--color-brand-red)");
  });

  it("structurally defines app drag regions, strong focus, and reduced motion", async () => {
    const global = postcss.parse(await readFile(resolve(stylesRoot, "global.css"), "utf8"));
    const declarations = new Map<string, Map<string, string>>();
    global.walkRules((rule) => {
      const values = new Map<string, string>();
      rule.walkDecls((declaration) => values.set(declaration.prop, declaration.value));
      declarations.set(rule.selector, values);
    });
    expect(declarations.get(".appDragRegion")?.get("-webkit-app-region")).toBe("drag");
    expect(declarations.get(".appNoDrag")?.get("-webkit-app-region")).toBe("no-drag");
    expect(
      [...declarations.entries()].some(
        ([selector, values]) =>
          selector.includes(":focus-visible") && values.get("outline") === "2px solid var(--color-focus)",
      ),
    ).toBe(true);
    const reduced = global.nodes.find(
      (node) => node.type === "atrule" && node.params.includes("prefers-reduced-motion"),
    );
    expect(reduced?.toString()).toContain("0.01ms");
  });

  it("imports local tokens before global styles from renderer startup", async () => {
    const startup = await readFile(resolve(rendererRoot, "main.tsx"), "utf8");
    const tokens = startup.indexOf('import "./styles/tokens.css";');
    const global = startup.indexOf('import "./styles/global.css";');
    expect(tokens).toBeGreaterThanOrEqual(0);
    expect(global).toBeGreaterThan(tokens);
  });

  it("uses the shared Vite CSP nonce instead of forbidden style attributes", async () => {
    const files = (await readdir(rendererRoot, { recursive: true }))
      .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      .map((name) => resolve(rendererRoot, name));
    const inlineStyleSites: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\bstyle\s*=/g)) inlineStyleSites.push(`${file}:${match.index}`);
    }
    expect(inlineStyleSites).toHaveLength(0);
    expect(await readFile(resolve(rendererRoot, "index.html"), "utf8")).not.toMatch(/\bstyle\s*=/);
    const appShell = await readFile(resolve(rendererRoot, "components/AppShell/AppShell.tsx"), "utf8");
    expect(appShell).toContain('document.querySelector<HTMLMetaElement>("meta[property=csp-nonce]")');
    expect(appShell).toContain("<style nonce={styleNonce}>");
    expect(appShell).toContain("--sidebar-width: ${clampSidebarWidth(sidebarWidth)}px");
  });
});
