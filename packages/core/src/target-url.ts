/** Join an already validated target origin and an HTTP origin-form path. */
export function targetUrlFromPath(
  targetOrigin: string,
  pathAndQuery: string,
): URL {
  if (!pathAndQuery.startsWith("/")) {
    throw new TypeError("pathAndQuery must start with /");
  }
  // URL reference resolution treats leading // as a replacement authority.
  // Concatenating after the fixed origin keeps every leading slash in the path.
  return new URL(`${new URL(targetOrigin).origin}${pathAndQuery}`);
}
