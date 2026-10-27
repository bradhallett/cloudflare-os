/** Path, formatting, and concurrency helpers shared by the Context Library page modules. */

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function resolveCollectionPath(baseDir: string, rel: string): string {
  rel = rel.split(/[?#]/)[0];
  let segs: string[] = [];
  if (!rel.startsWith("/") && baseDir) segs = baseDir.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

export function isExternalImageSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#");
}

/**
 * Strip a leading YAML frontmatter fence before rendering the preview — its fields already show in
 * the "When to use this" row.
 */
export function stripFrontmatter(source: string): string {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count !== 1 ? "s" : ""}`;
}

/** Bounded-concurrency helper for bulk RPC operations. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      await fn(items[next++]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

/** Segment-aware path-prefix replacement. */
export function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(fromPrefix + "/")) return toPrefix + path.slice(fromPrefix.length);
  return path;
}

export function dataUri(contentType: string, base64Body: string): string {
  return `data:${contentType};base64,${base64Body}`;
}
