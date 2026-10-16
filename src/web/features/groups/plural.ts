/** English counts: count(1, 'person', 'people') -> "1 person", count(3, ...) -> "3 people". */
export function count(n: number, one: string, many: string): string {
  return n + ' ' + (n === 1 ? one : many);
}
