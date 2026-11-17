/** `document.getElementById` that checks the element exists and has the expected type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or is not a ${type.name}`);
  return el;
}
