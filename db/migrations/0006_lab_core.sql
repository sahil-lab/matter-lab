-- 0006: lab core -- apparatus definitions, scenes, stations, apparatus instances, connections,
-- container inventories and reusable templates (Astra 3D laboratory extension, Agent 09).
--
-- Additive and backwards-compatible: no existing table is altered. Reuses data_sources (0001) for
-- provenance and matterlab_set_updated_at() (0001) for updated_at bookkeeping.
--
-- Evidence vocabulary for this extension (Observation.evidence, EquipmentDefinition.evidence) is
-- REFERENCE_MEASURED | MODEL_CALCULATED | ILLUSTRATIVE | UNVERIFIED | UNSUPPORTED, per
-- 00_SHARED_INTEGRATION_CONTRACT.md Section 3. It is deliberately not the same vocabulary as the
-- existing reactions.evidence_level column (reference/computed/rule-based/illustrative/user-input/
-- unsupported), which labels the pre-existing molecular/reaction editor's results.

-- ---------------------------------------------------------------------------------------------
-- Apparatus (equipment) definitions
-- ---------------------------------------------------------------------------------------------
--
-- One row per version of one definition, named after the brief's suggested apparatus_definition_
-- version table; "current" is the highest version for a key, exactly like data_sources(key,
-- version). Authored by Agent 03; Agent 09 serves, versions and seeds a provisional starter set.

CREATE TABLE apparatus_definition_version (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key               text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]*$'),
  version           integer NOT NULL CHECK (version > 0),
  kind              text NOT NULL CHECK (kind IN
                      ('BENCH', 'STAND', 'CLAMP', 'BURETTE', 'FLASK', 'BEAKER', 'PIPETTE', 'STIRRER', 'PH_PROBE', 'BALANCE', 'OTHER')),
  name              text NOT NULL CHECK (btrim(name) <> ''),
  description       text,
  capabilities      text[] NOT NULL DEFAULT '{}',
  sockets           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sockets) = 'array'),
  capacity          jsonb CHECK (capacity IS NULL OR jsonb_typeof(capacity) = 'object'),
  dimensions_m      jsonb CHECK (dimensions_m IS NULL OR jsonb_typeof(dimensions_m) = 'object'),
  control_actions   text[] NOT NULL DEFAULT '{}',
  default_config    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_config) = 'object'),
  evidence          text NOT NULL CHECK (evidence IN ('REFERENCE_MEASURED', 'MODEL_CALCULATED', 'ILLUSTRATIVE', 'UNVERIFIED', 'UNSUPPORTED')),
  notes             text,
  is_retired        boolean NOT NULL DEFAULT false,
  source_id         bigint NOT NULL REFERENCES data_sources (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apparatus_definition_version_key_version_key UNIQUE (key, version)
);

COMMENT ON TABLE apparatus_definition_version IS
  'Versioned apparatus catalog. A definition is never edited in place: a change is a new version row with the same key.';
COMMENT ON COLUMN apparatus_definition_version.key IS 'Stable catalog key referenced by apparatus_instance.definition_key, e.g. burette-50ml.';
COMMENT ON COLUMN apparatus_definition_version.sockets IS 'Array of {id, kind, mates?, label?}; kind is MECHANICAL, FLUID, SENSOR or CONTROL.';
COMMENT ON COLUMN apparatus_definition_version.capacity IS 'Liquid capacity {value, unit, uncertainty?}, for definitions with the CONTAINER capability.';
COMMENT ON COLUMN apparatus_definition_version.control_actions IS 'LabAction.type values this apparatus accepts (SET_VALVE, TRANSFER, START_STIRRER, ...).';
COMMENT ON COLUMN apparatus_definition_version.evidence IS
  'UNVERIFIED for provisional stock definitions seeded by Agent 09 pending Agent 03''s authoritative asset specifications; never a fabricated measurement.';
COMMENT ON COLUMN apparatus_definition_version.is_retired IS 'True once a newer version replaces this one in new scenes; existing apparatus_instance rows keep referencing it.';

CREATE INDEX apparatus_definition_version_key_idx ON apparatus_definition_version (key, version DESC);
CREATE INDEX apparatus_definition_version_source_id_idx ON apparatus_definition_version (source_id);

-- ---------------------------------------------------------------------------------------------
-- Scenes, stations
-- ---------------------------------------------------------------------------------------------

CREATE TABLE lab_scene (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL CHECK (btrim(title) <> ''),
  schema_version     smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  simulation_config  jsonb NOT NULL CHECK (jsonb_typeof(simulation_config) = 'object'),
  viewport           jsonb CHECK (viewport IS NULL OR jsonb_typeof(viewport) = 'object'),
  revision           integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  owner_id           uuid,
  duplicated_from_id uuid REFERENCES lab_scene (id) ON DELETE SET NULL,
  source_id          bigint NOT NULL REFERENCES data_sources (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lab_scene IS 'One multi-station laboratory scene: the ExperimentScene aggregate root (00_SHARED_INTEGRATION_CONTRACT.md Section 3).';
COMMENT ON COLUMN lab_scene.revision IS 'Optimistic-concurrency counter, bumped on every PATCH; the API''s If-Match precondition is checked against this column.';
COMMENT ON COLUMN lab_scene.owner_id IS 'Opaque owner identifier from the API auth layer; NULL for scenes created without an owner (local development).';
COMMENT ON COLUMN lab_scene.duplicated_from_id IS 'Scene this one was duplicated from, kept for traceability only; a duplicate never shares rows with its origin.';

CREATE INDEX lab_scene_updated_at_idx ON lab_scene (updated_at DESC);
CREATE INDEX lab_scene_owner_id_idx ON lab_scene (owner_id);
CREATE INDEX lab_scene_source_id_idx ON lab_scene (source_id);

CREATE TRIGGER lab_scene_set_updated_at BEFORE UPDATE ON lab_scene
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE lab_station (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id    uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  position    integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_station_scene_id_id_key UNIQUE (scene_id, id)
);

COMMENT ON TABLE lab_station IS 'A station within a scene; two stations in one scene run independent experiments.';
COMMENT ON COLUMN lab_station.position IS 'Display order of the station within the scene.';

CREATE INDEX lab_station_scene_id_idx ON lab_station (scene_id, position);

-- ---------------------------------------------------------------------------------------------
-- Apparatus instances and connections
-- ---------------------------------------------------------------------------------------------

CREATE TABLE apparatus_instance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id             uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  station_id           uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN
                         ('BENCH', 'STAND', 'CLAMP', 'BURETTE', 'FLASK', 'BEAKER', 'PIPETTE', 'STIRRER', 'PH_PROBE', 'BALANCE', 'OTHER')),
  definition_key       text NOT NULL,
  definition_version   integer,
  position_m_x         double precision NOT NULL,
  position_m_y         double precision NOT NULL,
  position_m_z         double precision NOT NULL,
  quaternion_x         double precision NOT NULL DEFAULT 0,
  quaternion_y         double precision NOT NULL DEFAULT 0,
  quaternion_z         double precision NOT NULL DEFAULT 0,
  quaternion_w         double precision NOT NULL DEFAULT 1,
  instance_revision    integer NOT NULL DEFAULT 0 CHECK (instance_revision >= 0),
  config               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  capabilities         text[] NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apparatus_instance_scene_id_id_key UNIQUE (scene_id, id),
  CONSTRAINT apparatus_instance_station_fk FOREIGN KEY (scene_id, station_id) REFERENCES lab_station (scene_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE apparatus_instance IS 'One placed apparatus (ApparatusInstance). The scene_id/station_id composite FK keeps every instance inside its own scene.';
COMMENT ON COLUMN apparatus_instance.definition_key IS 'apparatus_definition_version.key this instance was placed from.';
COMMENT ON COLUMN apparatus_instance.definition_version IS 'apparatus_definition_version.version in effect when placed; NULL when the definition is not catalogued (ad hoc/legacy instance).';
COMMENT ON COLUMN apparatus_instance.position_m_x IS 'Scene-space position in metres (Transform.positionM[0]).';
COMMENT ON COLUMN apparatus_instance.instance_revision IS 'Agent 07''s per-instance revision counter, stored verbatim; not used for the scene-level If-Match check.';

CREATE INDEX apparatus_instance_scene_id_idx ON apparatus_instance (scene_id);
CREATE INDEX apparatus_instance_station_id_idx ON apparatus_instance (station_id);
CREATE INDEX apparatus_instance_definition_key_idx ON apparatus_instance (definition_key);

CREATE TRIGGER apparatus_instance_set_updated_at BEFORE UPDATE ON apparatus_instance
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE apparatus_connection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id         uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  from_instance_id uuid NOT NULL,
  from_socket_id   text NOT NULL,
  to_instance_id   uuid NOT NULL,
  to_socket_id     text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('MECHANICAL', 'FLUID', 'SENSOR', 'CONTROL')),
  enabled          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apparatus_connection_not_self CHECK (from_instance_id <> to_instance_id),
  CONSTRAINT apparatus_connection_from_fk FOREIGN KEY (scene_id, from_instance_id) REFERENCES apparatus_instance (scene_id, id) ON DELETE CASCADE,
  CONSTRAINT apparatus_connection_to_fk FOREIGN KEY (scene_id, to_instance_id) REFERENCES apparatus_instance (scene_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE apparatus_connection IS 'A socket-to-socket connection (Connection). Both ends are constrained to apparatus of the same scene.';

CREATE INDEX apparatus_connection_scene_id_idx ON apparatus_connection (scene_id);
CREATE INDEX apparatus_connection_from_instance_id_idx ON apparatus_connection (from_instance_id);
CREATE INDEX apparatus_connection_to_instance_id_idx ON apparatus_connection (to_instance_id);

-- ---------------------------------------------------------------------------------------------
-- Container inventories
-- ---------------------------------------------------------------------------------------------

CREATE TABLE container_state (
  apparatus_instance_id uuid PRIMARY KEY,
  scene_id              uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  volume_l              double precision NOT NULL CHECK (volume_l >= 0),
  species               jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(species) = 'array'),
  temperature_k         double precision NOT NULL CHECK (temperature_k > 0),
  mixing                text NOT NULL CHECK (mixing IN ('WELL_MIXED', 'UNMIXED')),
  model_id              text NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT container_state_instance_fk FOREIGN KEY (scene_id, apparatus_instance_id) REFERENCES apparatus_instance (scene_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE container_state IS
  'ContainerContents keyed by apparatus_instance_id (ExperimentScene.containerStates). One authoritative row per container-capable instance.';
COMMENT ON COLUMN container_state.species IS 'Array of {speciesId, moles, sourceId?}; moles are the sole conserved quantity the API transfers between containers.';

CREATE INDEX container_state_scene_id_idx ON container_state (scene_id);

CREATE TRIGGER container_state_set_updated_at BEFORE UPDATE ON container_state
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Templates (named reusable equipment assemblies)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE lab_template (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  description  text,
  apparatus    jsonb NOT NULL CHECK (jsonb_typeof(apparatus) = 'array'),
  connections  jsonb NOT NULL CHECK (jsonb_typeof(connections) = 'array'),
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  owner_id     uuid,
  source_id    bigint NOT NULL REFERENCES data_sources (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lab_template IS
  'A named, reusable apparatus assembly (e.g. "titration stand") that can be stamped into any scene. Denormalised JSONB: a template is a copy stamp, not a live link.';

CREATE UNIQUE INDEX lab_template_name_lower_key ON lab_template (lower(name));
CREATE INDEX lab_template_owner_id_idx ON lab_template (owner_id);
CREATE INDEX lab_template_source_id_idx ON lab_template (source_id);

CREATE TRIGGER lab_template_set_updated_at BEFORE UPDATE ON lab_template
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();
