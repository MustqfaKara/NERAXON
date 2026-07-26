const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function splitTelegramMessage(heading: string, message: string, maxLength = 3_800) {
  const contentLimit = Math.max(200, maxLength - heading.length - 40);
  const chunks: string[] = [];
  let current = "";
  for (const character of message) {
    const escaped = escapeHtml(character);
    if (current.length + escaped.length > contentLimit && current) {
      chunks.push(current);
      current = "";
    }
    current += escaped;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map((chunk, index) => {
    const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : "";
    return `${heading}${suffix}\n${chunk}`;
  });
}

export { escapeHtml };
