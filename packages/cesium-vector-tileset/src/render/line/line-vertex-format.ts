export const LINE_CORNER_REGULAR = 0;
export const LINE_CORNER_BUTT_PREV = 1;
export const LINE_CORNER_BUTT_NEXT = 2;
export const LINE_CORNER_JOIN_FAN = 3;
export const LINE_CORNER_ROUND_CAP = 4;
export const LINE_CORNER_SQUARE = 5;
export const LINE_CORNER_ANCHOR = 6;
// The two unused byte roles identify regular endpoint pairs, which provide
// flat cap coordinates to the cap quad and its adjacent strip segment.
export const LINE_CORNER_ROUND_END = 30;
export const LINE_CORNER_ROUND_BOTH_ENDS = 31;
export const MAX_FAN_VERTICES = 9;

// Exact Float32 values of f / max(1, n - 1), for every fan of 1..9 vertices.
// Roles 7..29 encode these values; the lower three bits retain side/direction.
export const LINE_FAN_PARAMETERS = [
  0,
  0.125,
  0.1428571492433548,
  0.1666666716337204,
  0.20000000298023224,
  0.25,
  0.2857142984867096,
  0.3333333432674408,
  0.375,
  0.4000000059604645,
  0.4285714328289032,
  0.5,
  0.5714285969734192,
  0.6000000238418579,
  0.625,
  0.6666666865348816,
  0.7142857313156128,
  0.75,
  0.800000011920929,
  0.8333333134651184,
  0.8571428656578064,
  0.875,
  1,
] as const;

export const LINE_FAN_PARAMETER_SHADER = `
const float lineFanParameters[${LINE_FAN_PARAMETERS.length}] = float[${LINE_FAN_PARAMETERS.length}](
    ${LINE_FAN_PARAMETERS.map(value => Number.isInteger(value) ? `${value}.0` : String(value)).join(', ')}
);`;
