import { expect, test } from "claude-code/testing";

test("recaps the previous session from its journal", {}, async ($, on) => {
  let asked = "";
  const store = new Map<string, unknown>();
  on("store.get", ($, e: any) => ({ value: store.get(e.key) }));
  on("store.set", ($, e: any) => { store.set(e.key, e.value); return { value: undefined }; });
  on("prompt.submit", ($, e: any) => ({ text: e.text }));
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/Users/me/Projects/portfolio" }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("tool.call", () => ({ result: "ran" }));
  on("turn.complete", () => ({ text: "I added a dark mode toggle." }));
  on("model.complete", ($, e) => {
    asked = e.prompt;
    return { value: { isAnswered: true, text: "SUMMARY — Added dark mode.\nWORDS TO LEARN\n- Toggle — an on/off switch — used for dark mode", usage: {} } };
  });

  // Session one: Claude edits a file.
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
  await $.prompt.submit({ text: "add dark mode" } as any);
  await $.tool.call({ tool: "Edit", file_path: "/work/app.css", old_string: "a", new_string: "b" } as any);
  await $.turn.complete({ reason: "answer", answer: "ok", durationMs: 1 } as any);

  // Session two: ask for a recap of session one.
  await new Promise(r => setTimeout(r, 5));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" } as any);
  await $.command.run({ command: "explain-it", args: "last" } as any);
  await new Promise(r => setTimeout(r, 50));

  expect(asked).toContain("I asked: add dark mode");
  expect(asked).toContain("Changed a file: /work/app.css");
  expect(asked).toContain("I added a dark mode toggle.");
  // The recap is saved, and "Toggle" joins the learned words.
  expect((store.get("saved-explanations") as any[]).at(-1).label).toContain("Recap");
  expect(store.get("learned-terms")).toEqual(["Toggle"]);
});
