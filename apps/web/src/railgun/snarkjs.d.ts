// snarkjs ships no types. Railgun's engine only needs its groth16 prover.
declare module 'snarkjs' {
  export const groth16: unknown;
}
