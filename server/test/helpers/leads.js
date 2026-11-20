/** CSV text with a header and n lead rows (test fixture). */
export function leadsCsv(n, { header = 'first_name,email,company', row = (i) => `Name ${i},user${i}@example.com,Co ${i}` } = {}) {
  return [header, ...Array.from({ length: n }, (_, i) => row(i + 1))].join('\n');
}
