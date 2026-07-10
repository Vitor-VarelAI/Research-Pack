const topStories = [101, 102];

const items = new Map<number, unknown>([
  [
    101,
    {
      id: 101,
      type: "story",
      title: "Show HN: OpenAI API workflow for designers",
      url: "https://example.com/openai-api-workflow",
      score: 123,
      descendants: 45,
    },
  ],
  [
    102,
    {
      id: 102,
      type: "story",
      title: "SQLite release notes",
      url: "https://example.com/sqlite",
      score: 20,
      descendants: 3,
    },
  ],
]);

globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  if (url.endsWith("/topstories.json")) {
    return Response.json(topStories);
  }

  const match = url.match(/\/item\/(\d+)\.json$/);
  if (match) {
    const item = items.get(Number(match[1]));
    if (item) return Response.json(item);
  }

  // Intentionally fail any unexpected request so tests cannot silently use the network.
  return Response.json({ error: "not found" }, { status: 404 });
};
