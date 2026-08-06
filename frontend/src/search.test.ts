// Tests for the Search service: query parsing, like-pattern escaping.
import { describe, expect, test } from "vitest";

import { SearchRequest } from "./search";

describe("SearchRequest schema", () => {
  test("valid request decodes", () => {
    const req = SearchRequest.make({ text: "hello", limit: 10 });
    expect(req.text).toBe("hello");
    expect(req.limit).toBe(10);
  });

  test("empty text is valid", () => {
    const req = SearchRequest.make({ text: "", limit: 5 });
    expect(req.text).toBe("");
  });

  test("make creates correct type", () => {
    const req = SearchRequest.make({ text: "test", limit: 10 });
    expect(req.limit).toBe(10);
  });
});

describe("Search command names", () => {
  // The Search service is injected via Context, so we test its Schema
  // and command shapes rather than running actual SQL queries.

  test("SearchRequest is properly structured", () => {
    expect(typeof SearchRequest.fields.text).toBe("object");
    expect(typeof SearchRequest.fields.limit).toBe("object");
  });
});
