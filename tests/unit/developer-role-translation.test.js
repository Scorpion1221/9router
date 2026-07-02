import { describe, it, expect } from "vitest";

import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const DEVELOPER_PROMPT = "DEV_PROMPT_XIAOQI";
const baseBody = () => ({
  messages: [
    { role: "developer", content: DEVELOPER_PROMPT },
    { role: "user", content: "USER_QUESTION" },
  ],
  max_completion_tokens: 64,
});

const targets = [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.CLAUDE,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
  FORMATS.VERTEX,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.OLLAMA,
  FORMATS.COMMANDCODE,
];

describe("developer role translation", () => {
  for (const target of targets) {
    it(`preserves developer instructions for ${target}`, () => {
      const out = translateRequest(
        FORMATS.OPENAI,
        target,
        "claude-sonnet-4-5",
        baseBody(),
        true,
        { email: "test@example.com", connectionId: "test-connection" },
        target,
      );
      const raw = JSON.stringify(out);
      expect(raw).toContain(DEVELOPER_PROMPT);
      expect(raw).not.toContain('"role":"developer"');
    });
  }
});
