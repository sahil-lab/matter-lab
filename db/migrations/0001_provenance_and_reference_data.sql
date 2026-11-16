-- 0001: provenance registry and the periodic-table reference data (elements, isotopes).
--
-- Conventions used by every MATTER LAB migration
--   * Physical quantities carry their unit in the column name (_u, _k, _ev, _angstrom, _seconds, ...).
--   * Every scientific record references data_sources(id): the dataset, software or import that
--     the row came from, including its version, URL, retrieval date and licence where known.
--   * Timestamps are timestamptz and are stored and served in UTC.

CREATE FUNCTION matterlab_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------------------------

CREATE TABLE data_sources (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text        NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version       text        NOT NULL CHECK (btrim(version) <> ''),
  kind          text        NOT NULL CHECK (kind IN ('reference-dataset', 'software', 'external-service', 'user', 'import')),
  title         text        NOT NULL CHECK (btrim(title) <> ''),
  publisher     text,
  url           text,
  license       text,
  retrieved_on  date,
  citations     jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_sources_key_version_key UNIQUE (key, version)
);

COMMENT ON TABLE data_sources IS
  'Provenance registry. One row per versioned snapshot of a dataset, software release, external service or import batch.';
COMMENT ON COLUMN data_sources.key IS 'Stable identifier of the source, e.g. pubchem-periodic-table or rdkit.';
COMMENT ON COLUMN data_sources.version IS
  'Dataset or software version. Sources that publish no version use the label "snapshot <retrieval date>" or "unversioned".';
COMMENT ON COLUMN data_sources.retrieved_on IS 'Date on which the snapshot was retrieved from the source (NULL when not applicable).';
COMMENT ON COLUMN data_sources.license IS 'Licence or usage terms as stated by the source; NULL when not known.';

CREATE TRIGGER data_sources_set_updated_at BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

-- Remembers which seed inputs have been loaded so that re-running the seeding step is cheap and idempotent.
CREATE TABLE seed_state (
  name          text        PRIMARY KEY,
  content_hash  text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  record_count  integer     NOT NULL CHECK (record_count >= 0),
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  applied_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE seed_state IS 'SHA-256 of each seed input that has been applied, with the number of records it produced.';

-- ---------------------------------------------------------------------------------------------
-- Elements
-- ---------------------------------------------------------------------------------------------

CREATE TABLE elements (
  atomic_number                     smallint PRIMARY KEY CHECK (atomic_number BETWEEN 1 AND 118),
  symbol                            text     NOT NULL CHECK (symbol ~ '^[A-Z][a-z]?$'),
  name                              text     NOT NULL CHECK (btrim(name) <> ''),
  standard_atomic_weight_u          double precision NOT NULL CHECK (standard_atomic_weight_u > 0),
  period                            smallint NOT NULL CHECK (period BETWEEN 1 AND 7),
  group_number                      smallint CHECK (group_number BETWEEN 1 AND 18),
  block                             text     NOT NULL CHECK (block IN ('s', 'p', 'd', 'f')),
  table_row                         smallint NOT NULL CHECK (table_row BETWEEN 1 AND 10),
  table_column                      smallint NOT NULL CHECK (table_column BETWEEN 1 AND 18),
  category                          text     NOT NULL CHECK (btrim(category) <> ''),
  standard_state                    text     NOT NULL CHECK (standard_state IN ('solid', 'liquid', 'gas')),
  standard_state_predicted          boolean  NOT NULL,
  electron_configuration            text     NOT NULL,
  electron_configuration_predicted  boolean  NOT NULL,
  electronegativity_pauling         double precision CHECK (electronegativity_pauling > 0),
  ionization_energy_ev              double precision CHECK (ionization_energy_ev > 0),
  electron_affinity_ev              double precision,
  oxidation_states                  smallint[] NOT NULL DEFAULT '{}',
  melting_point_k                   double precision CHECK (melting_point_k >= 0),
  boiling_point_k                   double precision CHECK (boiling_point_k >= 0),
  density_g_per_cm3                 double precision CHECK (density_g_per_cm3 > 0),
  year_discovered                   smallint,
  discovered_in_antiquity           boolean  NOT NULL DEFAULT false,
  covalent_radius_angstrom          double precision NOT NULL CHECK (covalent_radius_angstrom > 0),
  vdw_radius_angstrom               double precision NOT NULL CHECK (vdw_radius_angstrom > 0),
  vdw_radius_source                 text     NOT NULL CHECK (vdw_radius_source IN ('pubchem', 'rdkit', 'import')),
  cpk_color_hex                     text     NOT NULL CHECK (cpk_color_hex ~ '^#[0-9A-F]{6}$'),
  color_source                      text     NOT NULL CHECK (color_source IN ('pubchem', 'jmol', 'fallback', 'import')),
  valences                          smallint[] NOT NULL DEFAULT '{}',
  valence_unconstrained             boolean  NOT NULL,
  outer_electrons                   smallint NOT NULL CHECK (outer_electrons >= 0),
  most_common_isotope_mass_number   smallint NOT NULL CHECK (most_common_isotope_mass_number > 0),
  most_common_isotope_mass_u        double precision NOT NULL CHECK (most_common_isotope_mass_u > 0),
  source_id                         bigint   NOT NULL REFERENCES data_sources (id),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elements_symbol_key UNIQUE (symbol),
  CONSTRAINT elements_name_key UNIQUE (name),
  CONSTRAINT elements_discovery_year_or_antiquity CHECK (NOT (discovered_in_antiquity AND year_discovered IS NOT NULL))
);

COMMENT ON TABLE elements IS 'The 118 chemical elements. source_id is the primary source; element_sources lists every contributing source per field.';
COMMENT ON COLUMN elements.standard_atomic_weight_u IS 'Standard atomic weight in unified atomic mass units (u).';
COMMENT ON COLUMN elements.group_number IS 'IUPAC group 1-18; NULL for the lanthanide and actinide series.';
COMMENT ON COLUMN elements.table_row IS 'Row on the conventional 18-column table, with the f-block series drawn as rows 9 and 10.';
COMMENT ON COLUMN elements.electronegativity_pauling IS 'Pauling electronegativity (dimensionless).';
COMMENT ON COLUMN elements.ionization_energy_ev IS 'First ionisation energy in electronvolt.';
COMMENT ON COLUMN elements.electron_affinity_ev IS 'Electron affinity in electronvolt.';
COMMENT ON COLUMN elements.melting_point_k IS 'Melting point in kelvin.';
COMMENT ON COLUMN elements.boiling_point_k IS 'Boiling point in kelvin.';
COMMENT ON COLUMN elements.density_g_per_cm3 IS 'Density in gram per cubic centimetre, as listed by the source.';
COMMENT ON COLUMN elements.covalent_radius_angstrom IS 'Covalent radius in angstrom.';
COMMENT ON COLUMN elements.vdw_radius_angstrom IS 'Van der Waals radius in angstrom; vdw_radius_source says which source supplied it (import = changed by a workbook import).';
COMMENT ON COLUMN elements.cpk_color_hex IS 'Display colour (#RRGGBB). color_source = fallback marks elements without a conventional colour; import = changed by a workbook import.';
COMMENT ON COLUMN elements.most_common_isotope_mass_u IS 'Mass of the most common isotope in unified atomic mass units (u).';

CREATE INDEX elements_source_id_idx ON elements (source_id);

CREATE TRIGGER elements_set_updated_at BEFORE UPDATE ON elements
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE element_sources (
  atomic_number smallint NOT NULL REFERENCES elements (atomic_number) ON DELETE CASCADE,
  source_id     bigint   NOT NULL REFERENCES data_sources (id),
  fields        text[]   NOT NULL CHECK (cardinality(fields) > 0),
  PRIMARY KEY (atomic_number, source_id)
);

COMMENT ON TABLE element_sources IS 'Field-level provenance: which columns of an element row were taken from which source.';

CREATE INDEX element_sources_source_id_idx ON element_sources (source_id);

-- ---------------------------------------------------------------------------------------------
-- Isotopes (ground-state nuclides)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE isotopes (
  atomic_number              smallint NOT NULL REFERENCES elements (atomic_number),
  neutron_number             smallint NOT NULL CHECK (neutron_number >= 0),
  mass_number                smallint GENERATED ALWAYS AS (atomic_number + neutron_number) STORED,
  atomic_mass_u              double precision CHECK (atomic_mass_u > 0),
  mass_from_systematics      boolean  NOT NULL,
  natural_abundance_percent  double precision CHECK (natural_abundance_percent > 0 AND natural_abundance_percent <= 100),
  stability                  text     NOT NULL CHECK (stability IN ('S', 'R', 'U')),
  half_life_seconds          double precision CHECK (half_life_seconds > 0),
  half_life_limit            text     NOT NULL DEFAULT '' CHECK (half_life_limit IN ('', 'GT', 'LT', 'GE', 'LE', 'AP')),
  decay_mode                 text     CHECK (decay_mode <> ''),
  decay_percent              double precision CHECK (decay_percent >= 0 AND decay_percent <= 100),
  spin_parity                text     CHECK (spin_parity <> ''),
  source_id                  bigint   NOT NULL REFERENCES data_sources (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (atomic_number, neutron_number),
  CONSTRAINT isotopes_half_life_matches_stability CHECK ((stability = 'R') = (half_life_seconds IS NOT NULL))
);

COMMENT ON TABLE isotopes IS 'Evaluated ground-state nuclides. One row per (Z, N).';
COMMENT ON COLUMN isotopes.atomic_mass_u IS 'Atomic mass in unified atomic mass units (u); NULL when the mass has not been evaluated.';
COMMENT ON COLUMN isotopes.mass_from_systematics IS 'True when the mass is an estimate from systematics rather than a measurement.';
COMMENT ON COLUMN isotopes.natural_abundance_percent IS 'Natural isotopic abundance in percent; NULL when the nuclide does not occur naturally.';
COMMENT ON COLUMN isotopes.stability IS 'S = stable, R = radioactive with an evaluated half-life, U = half-life not evaluated.';
COMMENT ON COLUMN isotopes.half_life_seconds IS 'Half-life in seconds; NULL for stable nuclides and for nuclides without an evaluated half-life.';
COMMENT ON COLUMN isotopes.half_life_limit IS 'Qualifier on the half-life: a bound (GT, LT, GE, LE) or an approximate value (AP); empty when exact.';
COMMENT ON COLUMN isotopes.decay_mode IS 'Most probable decay mode in ENSDF notation (B-, EC+B+, A, SF, ...).';
COMMENT ON COLUMN isotopes.decay_percent IS 'Branching of that decay mode in percent, when evaluated.';
COMMENT ON COLUMN isotopes.spin_parity IS 'Ground-state spin and parity in ENSDF notation, e.g. 1/2+.';

CREATE INDEX isotopes_mass_number_idx ON isotopes (mass_number);
CREATE INDEX isotopes_source_id_idx ON isotopes (source_id);

CREATE TRIGGER isotopes_set_updated_at BEFORE UPDATE ON isotopes
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();
