// One scoring rule for every job: a 0..100 score becomes stars and pay. Finishing a shift is
// always at least one star; failing pays nothing.
export const starsOf = (score) => (score >= 85 ? 3 : score >= 65 ? 2 : 1);
export const payOf = (pay, stars) => Math.round((pay.base || 0) + (pay.perStar || 0) * (stars - 1) + (pay.perStar || 0) * 0.5 * (stars === 3 ? 1 : 0));
