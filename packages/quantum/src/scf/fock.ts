/**
 * Two-electron part of the closed-shell Fock matrix,
 *
 *   G_mu,nu = sum_{lambda sigma} P_{lambda sigma} [ (mu nu|lambda sigma) - 1/2 (mu lambda|nu sigma) ],
 *
 * from the packed table of unique integrals (see `EriTable`). Each unique integral (ij|kl), i >= j,
 * k >= l, ij >= kl, stands for up to eight index permutations; with its weight halved for every
 * coincidence (i = j, k = l, ij = kl) all eight Coulomb and exchange updates can be applied
 * unconditionally:
 *
 *   G_ij += 4 w P_kl    G_kl += 4 w P_ij
 *   G_ik -=   w P_jl    G_jk -=   w P_il    G_il -= w P_jk    G_jl -= w P_ik
 *
 * accumulated into a matrix that is symmetrised at the end, G = (g + g^T) / 2. The table is
 * traversed in storage order. The coincidences k = l and ij = kl occur only at the end of a row
 * of that traversal, so they are handled outside the inner loop, which then contains no branch
 * except the test that skips integrals removed by screening.
 *
 * `density`, `out` and `scratch` are row-major n x n; `out` may not alias `density`.
 */
export function buildTwoElectronFock(eri: Float64Array, density: Float64Array, n: number, out: Float64Array, scratch: Float64Array): void {
  const g = scratch;
  const p = density;
  g.fill(0);
  let ij = 0;
  for (let i = 0; i < n; i++) {
    const io = i * n;
    for (let j = 0; j <= i; j++, ij++) {
      const jo = j * n;
      const pij = p[io + j];
      const fourPij = 4 * pij;
      const braWeight = i === j ? 0.5 : 1;
      let coulomb = 0;
      let kl = (ij * (ij + 1)) / 2;

      // Rows k < i of the ket index: l = 0..k, with l = k the only diagonal ket.
      for (let k = 0; k < i; k++) {
        const ko = k * n;
        const pik = p[io + k];
        const pjk = p[jo + k];
        let exchangeI = 0;
        let exchangeJ = 0;
        for (let l = 0; l < k; l++, kl++) {
          const value = eri[kl];
          if (value === 0) continue;
          const w = value * braWeight;
          coulomb += w * p[ko + l];
          g[ko + l] += w * fourPij;
          exchangeI += w * p[jo + l];
          exchangeJ += w * p[io + l];
          g[io + l] -= w * pjk;
          g[jo + l] -= w * pik;
        }
        const diagonal = eri[kl++];
        if (diagonal !== 0) {
          const w = diagonal * braWeight * 0.5;
          coulomb += w * p[ko + k];
          g[ko + k] += w * fourPij;
          exchangeI += w * pjk;
          exchangeJ += w * pik;
          g[io + k] -= w * pjk;
          g[jo + k] -= w * pik;
        }
        g[io + k] -= exchangeI;
        g[jo + k] -= exchangeJ;
      }

      // Row k = i: l = 0..j, ending with the integral (ij|ij) itself.
      const pii = p[io + i];
      const pji = p[jo + i];
      let exchangeI = 0;
      let exchangeJ = 0;
      for (let l = 0; l < j; l++, kl++) {
        const value = eri[kl];
        if (value === 0) continue;
        const w = value * braWeight;
        coulomb += w * p[io + l];
        g[io + l] += w * fourPij;
        exchangeI += w * p[jo + l];
        exchangeJ += w * p[io + l];
        g[io + l] -= w * pji;
        g[jo + l] -= w * pii;
      }
      const last = eri[kl];
      if (last !== 0) {
        // ij = kl always halves the weight; i = j makes the ket diagonal as well.
        const w = last * braWeight * braWeight * 0.5;
        coulomb += w * pij;
        g[io + j] += w * fourPij;
        exchangeI += w * p[jo + j];
        exchangeJ += w * pij;
        g[io + j] -= w * pji;
        g[jo + j] -= w * pii;
      }
      g[io + i] -= exchangeI;
      g[jo + i] -= exchangeJ;
      g[io + j] += 4 * coulomb;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const value = 0.5 * (g[i * n + j] + g[j * n + i]);
      out[i * n + j] = value;
      out[j * n + i] = value;
    }
  }
}
