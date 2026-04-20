// Deduped starter roster captured from the project team list. Keeping this
// constant in a plain lib module (rather than a Next.js route file) is
// required because Next 15 rejects non-route exports from `app/api/*/route.ts`.
// It also lets pages and seed scripts share the same source of truth.
export const DEFAULT_PEOPLE: string[] = [
  "Kirit Joshi",
  "William Christensen",
  "Prajwal Tumkur Mahesh",
  "Steven Szczeszynski",
  "Logan Alexander",
  "Rachael Ortega",
  "Jasmine Milan",
  "Jacky Chen",
];
