-- 0009: curated reagent catalog for the lab REST API (Astra 3D laboratory extension, Agent 09).
--
-- A small, explicitly safe allow-list for the supported educational titration/dilution/buffer
-- experiments, cross-linked to the existing compound catalogue (0002) by InChIKey/name lookup at
-- seed time. Never a claim that these are the only substances that exist.

CREATE TABLE lab_reagent (
  species_id                 text PRIMARY KEY CHECK (btrim(species_id) <> ''),
  name                        text NOT NULL CHECK (btrim(name) <> ''),
  formula                     text NOT NULL CHECK (btrim(formula) <> ''),
  roles                       text[] NOT NULL DEFAULT '{}',
  science_compound_id         uuid REFERENCES compounds (id) ON DELETE SET NULL,
  recommended_concentration   jsonb CHECK (recommended_concentration IS NULL OR jsonb_typeof(recommended_concentration) = 'object'),
  hazard_notes                text,
  source_id                   bigint NOT NULL REFERENCES data_sources (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lab_reagent IS 'Curated, safe reagent allow-list for the lab API (SpeciesAmount.speciesId). Not a claim of completeness.';
COMMENT ON COLUMN lab_reagent.species_id IS 'Resolved chemical species identifier used by SpeciesAmount.speciesId, e.g. HCl(aq).';
COMMENT ON COLUMN lab_reagent.science_compound_id IS 'Matching row in the existing compounds catalogue (services/science), when one was found by name at seed time.';
COMMENT ON COLUMN lab_reagent.recommended_concentration IS '{min, max} mol/L, the safe pre-approved range for the educational templates.';

CREATE INDEX lab_reagent_science_compound_id_idx ON lab_reagent (science_compound_id);

CREATE TRIGGER lab_reagent_set_updated_at BEFORE UPDATE ON lab_reagent
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();
