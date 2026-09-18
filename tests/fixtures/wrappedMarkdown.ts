const paragraph =
  "The technical document explains how the service processes incoming requests, " +
  "checks the available information and returns a useful answer to the caller. " +
  "Each paragraph keeps its original wording while the editor adapts to the " +
  "formatting already present in the source document. ";

export function wrappedMarkdown(width = 80): string {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.repeat(4).trim().split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = "";
    }
    line += (line ? " " : "") + word;
  }
  lines.push(line);
  return (
    "# Technical document\n\n" + lines.join("\n") + "\n\n" + lines.join("\n")
  );
}
