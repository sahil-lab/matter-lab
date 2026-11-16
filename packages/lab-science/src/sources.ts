export interface ScienceSource {
  readonly id: string;
  readonly title: string;
  readonly authors: string;
  readonly version: string;
  readonly url: string;
  readonly accessedOn: string;
  readonly sourceLicense: string;
  readonly licenseUrl: string;
  readonly use: string;
}

const sources: readonly ScienceSource[] = [
  {
    id: 'openstax-chem2e-14-2',
    title: 'Chemistry 2e, 14.2: pH and pOH',
    authors: 'Paul Flowers, Klaus Theopold, Richard Langley, William R. Robinson; OpenStax',
    version: 'Chemistry 2e; live web edition accessed 2026-11-16',
    url: 'https://openstax.org/books/chemistry-2e/pages/14-2-ph-and-poh',
    accessedOn: '2026-11-16',
    sourceLicense: 'CC BY-NC-SA 4.0 (current publisher preface)',
    licenseUrl: 'https://openstax.org/books/chemistry-2e/pages/preface',
    use: 'Individual reference fact Kw = 1.0e-14 at 25 deg C; temperature dependence and concentration pH convention. No source prose, tables or images reproduced.',
  },
  {
    id: 'openstax-chem2e-14-3',
    title: 'Chemistry 2e, 14.3: Relative Strengths of Acids and Bases',
    authors: 'Paul Flowers, Klaus Theopold, Richard Langley, William R. Robinson; OpenStax',
    version: 'Chemistry 2e; live web edition accessed 2026-11-16',
    url: 'https://openstax.org/books/chemistry-2e/pages/14-3-relative-strengths-of-acids-and-bases',
    accessedOn: '2026-11-16',
    sourceLicense: 'CC BY-NC-SA 4.0 (current publisher preface)',
    licenseUrl: 'https://openstax.org/books/chemistry-2e/pages/preface',
    use: 'Individual facts acetic acid Ka = 1.8e-5 and ammonia Kb = 1.8e-5, aqueous 25 deg C educational values; conjugate Ka = Kw/Kb is calculated, not independently rounded.',
  },
  {
    id: 'openstax-chem2e-14-7',
    title: 'Chemistry 2e, 14.7: Acid-Base Titrations',
    authors: 'Paul Flowers, Klaus Theopold, Richard Langley, William R. Robinson; OpenStax',
    version: 'Chemistry 2e; live web edition accessed 2026-11-16',
    url: 'https://openstax.org/books/chemistry-2e/pages/14-7-acid-base-titrations',
    accessedOn: '2026-11-16',
    sourceLicense: 'CC BY-NC-SA 4.0 (current publisher preface)',
    licenseUrl: 'https://openstax.org/books/chemistry-2e/pages/preface',
    use: 'Independent strong/weak titration checks (Examples 14.21/14.22); methyl orange effective Ka = 4.0e-4, red/yellow transition, and endpoint/equivalence distinction. No titration table copied or used by the solver.',
  },
  {
    id: 'libretexts-indicators-24301',
    title: '17.3: Acid-Base Indicators (LibreTexts page 24301)',
    authors: 'LibreTexts contributors; OpenStax attribution on page',
    version: 'Page 24301; live page accessed 2026-11-16',
    url: 'https://chem.libretexts.org/Bookshelves/General_Chemistry/Map%3A_General_Chemistry_(Petrucci_et_al.)/17%3A_Additional_Aspects_of_Acid-Base_Equilibria/17.3%3A_Acid-Base_Indicators',
    accessedOn: '2026-11-16',
    sourceLicense: 'CC BY-NC-SA 4.0 page license; underlying OpenStax contribution also attributed CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    use: 'Individual phenolphthalein effective pKin = 9.5 (Figure 3 discussion), colorless/pink transition and methyl orange visible interval 3.1-4.4. Only bibliographic metadata and numerical facts retained.',
  },
  {
    id: 'harvard-bromothymol-blue-demo',
    title: 'Bromothymol Blue to Yellow by Breath',
    authors: 'Harvard Natural Sciences Lecture Demonstrations',
    version: 'Undated educational page; indexed numerical excerpt checked 2026-11-16',
    url: 'https://sciencedemonstrations.fas.harvard.edu/presentations/bromothymolblue',
    accessedOn: '2026-11-16',
    sourceLicense: 'No open-content license verified; retain only individual numerical facts and citation, not source prose or artwork.',
    licenseUrl: 'https://sciencedemonstrations.fas.harvard.edu/presentations/bromothymolblue',
    use: 'Indexed university excerpt explicitly gives effective pKa 7.2 and yellow/blue boundaries 6.0/7.6; direct page retrieval returned HTTP 403. No temperature calibration or physical uncertainty is established for this approximate trace-display constant.',
  },
];

export function getScienceSources(): readonly ScienceSource[] {
  return sources.map((source) => ({ ...source }));
}
