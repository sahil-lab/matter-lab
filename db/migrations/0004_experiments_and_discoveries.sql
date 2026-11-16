-- 0004: experiments (saved, reopenable work) and discovery candidates with their evidence trail.

-- ---------------------------------------------------------------------------------------------
-- Experiments
-- ---------------------------------------------------------------------------------------------

CREATE TABLE experiments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL CHECK (btrim(title) <> ''),
  description  text,
  kind         text,
  inputs       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inputs) = 'object'),
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  results      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(results) = 'object'),
  notes        text,
  tags         text[] NOT NULL DEFAULT '{}',
  reaction_id  uuid REFERENCES reactions (id) ON DELETE SET NULL,
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_id    bigint NOT NULL REFERENCES data_sources (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE experiments IS 'User experiments: everything needed to reopen and reproduce a piece of work.';
COMMENT ON COLUMN experiments.inputs IS 'Client-defined input document (structures, scene, parameters), stored verbatim.';
COMMENT ON COLUMN experiments.settings IS 'Client-defined settings document, stored verbatim.';
COMMENT ON COLUMN experiments.results IS 'Client-defined results document, stored verbatim. Computed results live in the linked calculations.';
COMMENT ON COLUMN experiments.revision IS 'Incremented on every update; used for optimistic concurrency.';

CREATE INDEX experiments_updated_at_idx ON experiments (updated_at DESC);
CREATE INDEX experiments_tags_idx ON experiments USING gin (tags);
CREATE INDEX experiments_reaction_id_idx ON experiments (reaction_id);
CREATE INDEX experiments_source_id_idx ON experiments (source_id);

CREATE TRIGGER experiments_set_updated_at BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE experiment_calculations (
  experiment_id   uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  calculation_id  uuid NOT NULL REFERENCES calculations (id) ON DELETE CASCADE,
  label           text,
  position        integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, calculation_id)
);

COMMENT ON TABLE experiment_calculations IS 'Calculations that belong to an experiment, in the order the client linked them.';

CREATE INDEX experiment_calculations_calculation_id_idx ON experiment_calculations (calculation_id);

-- ---------------------------------------------------------------------------------------------
-- Discovery candidates
-- ---------------------------------------------------------------------------------------------
--
-- The status ladder is deliberately modest. "no-match-in-searched-catalogs" states only that the
-- catalogues listed in discovery_catalog_searches returned no exact match at the recorded times.

CREATE TABLE discoveries (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                       text NOT NULL CHECK (btrim(title) <> ''),
  notes                       text,
  status                      text NOT NULL CHECK (status IN (
                                'user-created',
                                'structurally-validated',
                                'no-match-in-searched-catalogs',
                                'computationally-plausible',
                                'experimentally-observed',
                                'independently-validated')),
  input_format                text NOT NULL CHECK (input_format IN ('smiles', 'molblock')),
  input_structure             text NOT NULL CHECK (input_structure <> ''),
  structure_valid             boolean NOT NULL,
  validation                  jsonb NOT NULL CHECK (jsonb_typeof(validation) = 'object'),
  canonical_smiles            text,
  inchi                       text,
  inchikey                    text CHECK (inchikey ~ '^[A-Z]{14}-[A-Z]{10}-[A-Z]$'),
  molecular_formula           text,
  molblock                    text,
  molecular_weight_g_per_mol  double precision CHECK (molecular_weight_g_per_mol > 0),
  monoisotopic_mass_u         double precision CHECK (monoisotopic_mass_u > 0),
  derived_by                  jsonb CHECK (jsonb_typeof(derived_by) = 'object'),
  source_id                   bigint NOT NULL REFERENCES data_sources (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discoveries_valid_has_identifiers CHECK (
    NOT structure_valid
    OR (canonical_smiles IS NOT NULL AND inchi IS NOT NULL AND inchikey IS NOT NULL
        AND molecular_formula IS NOT NULL AND derived_by IS NOT NULL)
  ),
  CONSTRAINT discoveries_invalid_stays_user_created CHECK (structure_valid OR status = 'user-created')
);

COMMENT ON TABLE discoveries IS 'Discovery candidates: user-proposed structures, their validation, catalogue searches and evidence.';
COMMENT ON COLUMN discoveries.status IS
  'Position on the evidence ladder. No status asserts that a compound is previously unknown; see discovery_catalog_searches for exactly what was searched.';
COMMENT ON COLUMN discoveries.input_structure IS 'The structure exactly as submitted.';
COMMENT ON COLUMN discoveries.validation IS 'RDKit validation report for the submitted structure, including RDKit''s own error messages.';
COMMENT ON COLUMN discoveries.molecular_weight_g_per_mol IS 'Average molecular weight in g/mol (RDKit).';
COMMENT ON COLUMN discoveries.monoisotopic_mass_u IS 'Monoisotopic mass in unified atomic mass units (RDKit).';

CREATE INDEX discoveries_inchikey_idx ON discoveries (inchikey);
CREATE INDEX discoveries_status_idx ON discoveries (status);
CREATE INDEX discoveries_updated_at_idx ON discoveries (updated_at DESC);
CREATE INDEX discoveries_source_id_idx ON discoveries (source_id);

CREATE TRIGGER discoveries_set_updated_at BEFORE UPDATE ON discoveries
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE discovery_catalog_searches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id      uuid NOT NULL REFERENCES discoveries (id) ON DELETE CASCADE,
  catalog_key       text NOT NULL CHECK (btrim(catalog_key) <> ''),
  catalog_title     text NOT NULL CHECK (btrim(catalog_title) <> ''),
  catalog_scope     text NOT NULL CHECK (catalog_scope IN ('local', 'external')),
  search_method     text NOT NULL CHECK (btrim(search_method) <> ''),
  parameters        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
  records_searched  bigint CHECK (records_searched >= 0),
  searched_at       timestamptz NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('match', 'no-match', 'error')),
  matches           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(matches) = 'array'),
  detail            text,
  request_url       text,
  http_status       integer CHECK (http_status BETWEEN 100 AND 599),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_catalog_searches_local_has_count CHECK (catalog_scope <> 'local' OR records_searched IS NOT NULL)
);

COMMENT ON TABLE discovery_catalog_searches IS 'Every catalogue search made for a candidate: which catalogue, how, how many records, when, and the outcome.';
COMMENT ON COLUMN discovery_catalog_searches.records_searched IS
  'Number of records in the catalogue at search time. NULL only for external services that do not report it.';
COMMENT ON COLUMN discovery_catalog_searches.outcome IS
  'match = at least one hit, no-match = the search completed without a hit, error = the search could not be completed (not a negative result).';
COMMENT ON COLUMN discovery_catalog_searches.request_url IS 'URL requested, for external lookups.';

CREATE INDEX discovery_catalog_searches_discovery_idx ON discovery_catalog_searches (discovery_id, searched_at);

CREATE TABLE discovery_evidence (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id       uuid NOT NULL REFERENCES discoveries (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN (
                       'structure-validation',
                       'catalog-search',
                       'external-lookup',
                       'calculation',
                       'experimental-observation',
                       'independent-validation',
                       'status-change',
                       'note',
                       'import')),
  summary            text NOT NULL CHECK (btrim(summary) <> ''),
  details            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  recorded_by        text NOT NULL CHECK (recorded_by IN ('service', 'user')),
  calculation_id     uuid REFERENCES calculations (id) ON DELETE SET NULL,
  catalog_search_id  uuid REFERENCES discovery_catalog_searches (id) ON DELETE SET NULL,
  reference          text,
  status_before      text,
  status_after       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE discovery_evidence IS 'Append-only evidence trail of a discovery candidate.';
COMMENT ON COLUMN discovery_evidence.recorded_by IS 'service = established by this service; user = asserted by the user and not verified by the service.';
COMMENT ON COLUMN discovery_evidence.reference IS 'Citation, DOI, URL or lab-notebook reference supplied with user evidence.';

CREATE INDEX discovery_evidence_discovery_idx ON discovery_evidence (discovery_id, created_at);
CREATE INDEX discovery_evidence_calculation_id_idx ON discovery_evidence (calculation_id);
CREATE INDEX discovery_evidence_catalog_search_id_idx ON discovery_evidence (catalog_search_id);
