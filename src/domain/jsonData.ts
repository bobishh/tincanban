/** Copy JSON data without retaining references or traversing storage proxies later. */
export function cloneJsonData<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}
