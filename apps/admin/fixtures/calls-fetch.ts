export function load(): Promise<Response> {
  return fetch("/health");
}
