/**
 * Citations for the real-world dimensions used across `definitions/**`. Referenced by id from each
 * definition's `provenance.sourceIds`. Dimensions are drawn from ISO-conformant laboratory
 * glassware/hardware catalog specifications rather than invented proportions; where no citable
 * figure was available for a specific part, the definition says so and marks that dimension
 * `ILLUSTRATIVE` instead of `REFERENCE_MEASURED`.
 */
export interface DimensionSource {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly url?: string;
}

export const DIMENSION_SOURCES: readonly DimensionSource[] = [
  {
    id: 'iso-385-burette-50ml',
    title: 'ISO 385:2005 — Laboratory glassware, burettes',
    detail:
      'Class A/B 50 mL burette: overall length ~770-780 mm, bore inner diameter ~11 mm, 0.1 mL graduation, Class A tolerance +/-0.05 mL.',
    url: 'https://www.iso.org/standard/38678.html',
  },
  {
    id: 'iso-1773-erlenmeyer-250ml',
    title: 'ISO 1773 — Laboratory glassware, narrow-neck Erlenmeyer (conical) flasks',
    detail: '250 mL narrow-neck conical flask: height ~145 mm, base diameter ~85 mm, neck inner diameter ~34 mm.',
    url: 'https://www.dwk.com/duran-erlenmeyer-flask-narrow-neck-250-ml-212163605',
  },
  {
    id: 'iso-3819-beaker-250ml',
    title: 'ISO 3819 — Laboratory glassware, beakers',
    detail: '250 mL low-form beaker: height ~95 mm, outer diameter ~70 mm.',
    url: 'https://docs.rs-online.com/6a54/A700000009368415.pdf',
  },
  {
    id: 'retort-stand-catalog',
    title: 'Laboratory retort/ring stand catalog specifications',
    detail: 'Rod height commonly 600 mm (range 500-750 mm), base ~200x125 mm, rod diameter ~10 mm.',
    url: 'https://stonylab.com/products/b0bl73x2ny-lab-stand-set',
  },
  {
    id: 'boss-head-clamp-catalog',
    title: 'Boss head / burette clamp catalog specifications',
    detail: 'Boss head body ~40-60 mm, accommodates rods/clamp stems in the ~8-16 mm range.',
    url: 'https://www.rapidonline.com/eisco-mtst5-laboratory-retort-stand-set-52-3705',
  },
  {
    id: 'lab-bench-height-catalog',
    title: 'Standard laboratory bench planning guidance',
    detail: 'Standing laboratory bench/work height commonly 850-900 mm.',
    url: 'https://landrolab.com/laboratory-bench-dimensions/',
  },
  {
    id: 'iso-1042-volumetric-flask-250ml',
    title: 'ISO 1042 — Laboratory glassware, one-mark volumetric flasks',
    detail: '250 mL Class A/B volumetric flask: overall height (with stopper) ~215-235 mm, bulb diameter ~80 mm.',
    url: 'https://www.homesciencetools.com/product/volumetric-flask-250-ml/',
  },
  {
    id: 'iso-835-volumetric-pipette-25ml',
    title: 'ISO 835 / ISO 648 — Volumetric glassware, one-mark pipettes',
    detail: '25 mL Class A/AS volumetric (transfer) pipette: overall length commonly ~520 mm (manufacturer range ~520-570 mm).',
    url: 'https://www.labunlimited.com/s/58/4AJ-9272269/Isolab-Volumetric-Pipettes-25ml-Class-AS-520mm-021.05.025',
  },
  {
    id: 'test-tube-16x100-catalog',
    title: 'Laboratory test tube catalog specifications (16 x 100 mm)',
    detail: '16 mm outer diameter x 100 mm length is one of the most common round-bottom test tube sizes; nominal brim-full capacity ~12-14 mL.',
    url: 'https://www.dwk.com/pyrex-test-tubes-medium-wall-with-rim-16-x-100-mm-162009m',
  },
  {
    id: 'ph-combination-electrode-catalog',
    title: 'Combination pH electrode catalog specifications',
    detail: 'Laboratory combination pH electrodes commonly use a 12 mm shaft diameter, with shaft lengths typically 120-225 mm depending on model (e.g. METTLER TOLEDO LE409: 12 mm x 120 mm).',
    url: 'https://www.mt.com/ph/en/home/products/Laboratory_Analytics_Browse/pH-meter/sensor/pH-sensor/pH-Sensor-LE409.html',
  },
  {
    id: 'magnetic-stirrer-hotplate-catalog',
    title: 'Magnetic stirrer hotplate catalog specifications',
    detail:
      'Compact magnetic stirrer hotplates commonly have circular ceramic/aluminum plates roughly 120-180 mm across in bodies roughly 150-220 mm on a side (e.g. IKA C-MAG HS7: 180x180 mm plate, 220x330x105 mm body). The modeled unit is a smaller compact-class stirrer with proportions informed by, not a reproduction of, this specific model.',
    url: 'https://www.ika.hu/wp-content/uploads/2018/08/3581200_Data_Sheet_C-MAG_HS_7.pdf',
  },
  {
    id: 'reagent-bottle-catalog',
    title: 'Reagent bottle catalog specifications (ISO 4796 narrow-neck style)',
    detail:
      '250 mL narrow-neck reagent bottle (ground-joint/stopper style): height ~143-145 mm, outer diameter ~70-73 mm. The modeled unit is a round-shoulder screw-cap bottle, a different common style sized in the same proportions as this reference rather than an exact reproduction of it.',
    url: 'https://www.arcoscientific.com/shop/laboratory-glassware/bottles/bottle-reagent-narrow-neck-with-pp-stopper-250ml/',
  },
];

const SOURCE_BY_ID = new Map(DIMENSION_SOURCES.map((s) => [s.id, s]));

export function dimensionSource(id: string): DimensionSource {
  const source = SOURCE_BY_ID.get(id);
  if (!source) throw new Error(`Unknown dimension source id: ${id}`);
  return source;
}
