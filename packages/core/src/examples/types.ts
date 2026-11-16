export interface ExampleRecord {
  readonly id: string;
  readonly name: string;
  /** Canonical SMILES of the structure (hydrogens implicit). */
  readonly smiles: string;
  readonly description: string;
  /** [atomic number, formal charge, x, y, z] with coordinates in angstrom. */
  readonly atoms: ReadonlyArray<readonly number[]>;
  /** [atom index, atom index, bond order]; 1.5 marks an aromatic bond. */
  readonly bonds: ReadonlyArray<readonly number[]>;
}
