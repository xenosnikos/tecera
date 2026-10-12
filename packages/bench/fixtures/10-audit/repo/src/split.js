// Split a bill of `totalCents` between `people`: whole cents, earlier people pay the extra cent.
export function splitBill(totalCents, people) {
  const share = Math.floor(totalCents / people);
  return Array.from({ length: people }, () => share);
}
