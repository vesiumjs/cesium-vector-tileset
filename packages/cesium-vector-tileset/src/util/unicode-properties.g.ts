// This file is generated. Edit build/generate-unicode-data.ts, then run `npm run generate-unicode-data`.

/**
 * Returns whether the fallback fonts specified by the
 * `localIdeographFontFamily` map option apply to the given codepoint.
 */
export function codePointUsesLocalIdeographFontFamily(codePoint: number): boolean {
  return /[\u02EA\u02EB\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]|\uD81B[\uDFE0-\uDFFF]|[\uD81C-\uD822\uD840-\uD868\uD86A-\uD86D\uD86F-\uD872\uD874-\uD879\uD880-\uD883\uD885-\uD88C][\uDC00-\uDFFF]|\uD823[\uDC00-\uDCD5\uDCFF-\uDD1E\uDD80-\uDDF2]|\uD82B[\uDFF0-\uDFFF]|\uD82C[\uDC00-\uDEFB]|\uD83C[\uDE00-\uDEFF]|\uD869[\uDC00-\uDEDF\uDF00-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEAD\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0\uDFF0-\uDFFF]|\uD87B[\uDC00-\uDE5D]|\uD87E[\uDC00-\uDE1D]|\uD884[\uDC00-\uDF4A\uDF50-\uDFFF]|\uD88D[\uDC00-\uDC79]/.test(String.fromCodePoint(codePoint));
}

/**
 * Returns whether the given codepoint participates in ideographic line
 * breaking.
 */
export function codePointAllowsIdeographicBreaking(codePoint: number): boolean {
  return /[\u02EA\u02EB\u2E80-\u2FDF\u2FF0-\u303F\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF\u3105-\u312F\u31A0-\u4DBF\u4E00-\uA48C\uA490-\uA4C6\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE4F\uFF00-\uFFEF]|\uD81B[\uDFE0-\uDFFF]|[\uD81C-\uD822\uD840-\uD868\uD86A-\uD86D\uD86F-\uD872\uD874-\uD879\uD880-\uD883\uD885-\uD88C][\uDC00-\uDFFF]|\uD823[\uDC00-\uDCD5\uDCFF-\uDD1E\uDD80-\uDDF2]|\uD82B[\uDFF0-\uDFFF]|\uD82C[\uDC00-\uDEFB]|\uD83C[\uDE00-\uDEFF]|\uD869[\uDC00-\uDEDF\uDF00-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEAD\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0\uDFF0-\uDFFF]|\uD87B[\uDC00-\uDE5D]|\uD87E[\uDC00-\uDE1D]|\uD884[\uDC00-\uDF4A\uDF50-\uDFFF]|\uD88D[\uDC00-\uDC79]/.test(String.fromCodePoint(codePoint));
}

/**
 * Returns true if the given Unicode codepoint identifies a character with
 * upright orientation.
 *
 * A character has upright orientation if it is drawn upright (unrotated)
 * whether the line is oriented horizontally or vertically, even if both
 * adjacent characters can be rotated. For example, a Chinese character is
 * always drawn upright. An uprightly oriented character causes an adjacent
 * “neutral” character to be drawn upright as well.
 */
export function codePointHasUprightVerticalOrientation(codePoint: number): boolean {
  // eslint-disable-next-line regexp/no-dupe-characters-character-class -- Unicode ranges overlap by design
  return /[\u02EA\u02EB\u1100-\u11FF\u1400-\u167F\u18B0-\u18F5\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u3007\u3012\u3013\u3020-\u302F\u3031-\u303F\u3041-\u3096\u309D-\u30FB\u30FD-\u30FF\u3105-\u312F\u3131-\u318E\u3190-\uA48C\uA490-\uA4C6\uA960-\uA97C\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFE10-\uFE1F\uFE30-\uFE48\uFE50-\uFE57\uFE5F-\uFE62\uFE67-\uFE6F\uFF00-\uFF07\uFF0A-\uFF0C\uFF0E-\uFF19\uFF1F-\uFF3A\uFF3C\uFF3E\uFF40-\uFF5A\uFFE0-\uFFE2\uFFE4-\uFFE7]|\uD802[\uDD80-\uDD9F]|\uD805[\uDD80-\uDDFF]|\uD806[\uDE00-\uDEBF]|\uD811[\uDC00-\uDE7F]|\uD81B[\uDFE0-\uDFE4\uDFF0-\uDFF6]|[\uD81C-\uD822\uD83D\uD840-\uD868\uD86A-\uD86D\uD86F-\uD872\uD874-\uD879\uD880-\uD883\uD885-\uD88C][\uDC00-\uDFFF]|\uD823[\uDC00-\uDCD5\uDCFF-\uDD1E\uDD80-\uDDF2]|\uD82B[\uDFF0-\uDFF3\uDFF5-\uDFFB\uDFFD\uDFFE]|\uD82C[\uDC00-\uDD22\uDD30-\uDEFB]|\uD833[\uDEC0-\uDFCF]|\uD834[\uDC00-\uDDFF\uDEE0-\uDF7F]|\uD836[\uDC00-\uDEAF]|\uD83C[\uDC00-\uDE00\uDF00-\uDFFF]|\uD83E[\uDD00-\uDEFF]|\uD869[\uDC00-\uDEDF\uDF00-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEAD\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0\uDFF0-\uDFFF]|\uD87B[\uDC00-\uDE5D]|\uD87E[\uDC00-\uDE1D]|\uD884[\uDC00-\uDF4A\uDF50-\uDFFF]|\uD88D[\uDC00-\uDC79]/i.test(String.fromCodePoint(codePoint));
}

/**
 * Returns true if the given Unicode codepoint identifies a character with
 * neutral orientation.
 *
 * A character has neutral orientation if it may be drawn rotated or unrotated
 * when the line is oriented vertically, depending on the orientation of the
 * adjacent characters. For example, along a vertically oriented line, the
 * vulgar fraction ½ is drawn upright among Chinese characters but rotated among
 * Latin letters. A neutrally oriented character does not influence whether an
 * adjacent character is drawn upright or rotated.
 */
export function codePointHasNeutralVerticalOrientation(codePoint: number): boolean {
  return /[\xA7\xA9\xAE\xB1\xBC-\xBE\xD7\xF7\u2016\u2020\u2021\u2030\u2031\u203B\u203C\u2042\u2047-\u2049\u2051\u2100-\u218F\u221E\u2234\u2235\u2300-\u2307\u230C-\u231F\u2324-\u2328\u232B\u237D-\u239A\u23BE-\u23CD\u23CF\u23D1-\u23DB\u23E2-\u2422\u2424-\u24FF\u25A0-\u2619\u2620-\u2767\u2776-\u2793\u2B12-\u2B2F\u2B50-\u2B59\u2BB8-\u2BEB\u3000-\u303F\u30A0-\u30FF\uE000-\uF8FF\uFE30-\uFE6F\uFF00-\uFFEF\uFFFC\uFFFD]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/.test(String.fromCodePoint(codePoint));
}

/**
 * Returns whether the give codepoint is likely to require complex text shaping.
 */
export function codePointRequiresComplexTextShaping(codePoint: number): boolean {
  return /[\u0900-\u0DFF\u0F00-\u109F\u1780-\u17FF]/.test(String.fromCodePoint(codePoint));
}

/** Delta-encoded Arabic joining types from Unicode 17.0.0. */
export const ENCODED_JOINING_TYPES: Record<string, string> = {
  C: '18g,1;g2,3;4nb,1',
  D: '17k,1;5,1;1,1;1,5;4,d;1,7;1,2;z,2;8,g;i,12;1,2;9,1;1,1;1,2;14,3;2,1;28,9;3,f;2,4;1,1;2,3;2,6;7a,1;2,5;1,1;g,a;5,2;2,6;1,f',
  R: '17m,4;1,1;1,1;5,4;l,1;14,3;1,3;g,i;12,1;2,9;1,1;1,1;2,2;1,1;o,2;2x,3;f,2;4,1;1,2;3,2;6u,j;b,1;r,3;1,1;2,2;6,1',
  T: '4t,1;gi,34;7n,7;7b,19;1,1;1,2;1,2;1,1;20,b;1,1;1a,l;g,1;2t,7;2,6;2,2;1,4;x,1;1,1;u,r;2j,b;1m,9;9,1;o,4;1,9;1,3;1,5;17,3;1n,9;16,o;1,w;1j,1;1,1;4,8;4,1;3,7;a,2;t,1;1m,1;4,4;8,1;k,2;q,1;2,2;1l,1;4,2;4,2;2,3;3,1;u,2;3,1;b,2;1l,1;4,5;1,2;4,1;k,2;m,6;1,1;1m,1;2,1;1,4;8,1;7,2;b,2;u,1;1p,1;c,1;1e,1;3,1;1j,1;1,3;5,3;1,4;7,2;b,2;t,1;1m,1;2,1;6,1;5,2;k,2;s,2;1l,2;4,4;8,1;k,2;t,1;20,1;7,3;1,1;2i,1;2,7;c,8;2q,1;2,9;b,7;21,2;r,1;1,1;1,1;1j,e;1,5;1,2;5,b;1,10;9,1;2u,4;1,6;1,2;2,2;p,2;4,3;g,4;d,1;2,2;6,1;f,1;jj,3;qa,3;t,2;u,2;u,2;1s,2;1,7;8,1;2,b;9,1;19,3;1,1;39,2;y,1;3a,3;4,2;9,1;6,3;63,2;2,1;1m,1;1,7;1,1;1,1;2,8;6,a;2,1;1c,1a;2,c;k,4;1c,1;1,5;1,1;5,1;14,9;c,2;w,4;2,2;1,3;1k,1;1,2;3,1;1,3;1m,8;2,2;48,3;1,d;1,7;4,1;6,1;3,2;5i,1s;ej,1;2,2;q,5;1d,5;5,6;2o,x;2da,3;3x,1;2o,w;fe,4;2z,2;n9w,4;1,a;w,2;28,2;7k,1;3,1;4,1;p,2;5,1;47,2;q,i;d,1;12,8;p,b;1a,3;1c,1;2,4;2,2;13,1;1v,6;2,2;2,2;c,1;8,1;1b,1;1f,1;1,3;2,2;5,2;1,1;16,2;8,1;6m,1;2,1;4,1;fn4,1;kh,g;g,g;5r,1;6x,3;e9,1;6a,1;45,5;1ae,3;1,2;5,4;14,3;4,1;4l,2;fx,4;1t,5;8t,2;25,6;1y,b;1d,4;3f,1;1i,f;15,1;2,2;a,3;1d,4;2,2;7,1;1p,3;10,5;1,8;1q,1;c,2;1g,9;a,4;2,1;2n,3;2,1;1,2;6,1;2,1;4d,1;3,8;l,2;1l,2;3,1;11,7;3,5;1y,6;d,1;1,1;1,1;e,2;2d,8;2,3;1,1;n,1;2c,6;1,1;4,2;1,2;6m,4;6,2;1,2;r,2;2d,8;2,1;1,2;2y,1;1,1;2,6;1,1;2t,1;1,1;2,4;1,5;77,9;1,2;74,2;1,1;4,1;40,4;2,2;4,1;w,a;14,6;2,4;8,1;9,6;2,3;1a,d;1,2;5i,1;1,3;1,1;5l,7;1,6;1,1;2a,m;2,7;1,2;1,2;3e,6;3,1;1,2;1,7;1,1;20,2;3,1;1,1;9n,2;b,2;1g,5;5,1;1,1;n,1;445,h;6,f;8ug,c;3,3;1xc,5;1n,7;t4,1;1r,4;29,1;f5k,2;1,4;3mk,1a;2,n;f4,3;9,g;2,7;u,4;44,3;1iz,1j;4,1e;8,1;e,1;m,5;1,f;11s,7;1,h;2,7;1,2;1,5;2s,1;4g,7;af,1;1p,4;e4,4;72,2;6r,1;2,1;7,2;5,1;d6,7;31,8;gzat,1;u,2o;3k,6o',
};

/** Arabic glyph forms, indexed as isolated, final, initial, medial. */
export const PRESENTATION_FORMS: Record<number, [number, number, number, number]> = {
  1569: [65152, 0, 0, 0],
  1570: [65153, 65154, 0, 0],
  1571: [65155, 65156, 0, 0],
  1572: [65157, 65158, 0, 0],
  1573: [65159, 65160, 0, 0],
  1574: [65161, 65162, 65163, 65164],
  1575: [65165, 65166, 0, 0],
  1576: [65167, 65168, 65169, 65170],
  1577: [65171, 65172, 0, 0],
  1578: [65173, 65174, 65175, 65176],
  1579: [65177, 65178, 65179, 65180],
  1580: [65181, 65182, 65183, 65184],
  1581: [65185, 65186, 65187, 65188],
  1582: [65189, 65190, 65191, 65192],
  1583: [65193, 65194, 0, 0],
  1584: [65195, 65196, 0, 0],
  1585: [65197, 65198, 0, 0],
  1586: [65199, 65200, 0, 0],
  1587: [65201, 65202, 65203, 65204],
  1588: [65205, 65206, 65207, 65208],
  1589: [65209, 65210, 65211, 65212],
  1590: [65213, 65214, 65215, 65216],
  1591: [65217, 65218, 65219, 65220],
  1592: [65221, 65222, 65223, 65224],
  1593: [65225, 65226, 65227, 65228],
  1594: [65229, 65230, 65231, 65232],
  1601: [65233, 65234, 65235, 65236],
  1602: [65237, 65238, 65239, 65240],
  1603: [65241, 65242, 65243, 65244],
  1604: [65245, 65246, 65247, 65248],
  1605: [65249, 65250, 65251, 65252],
  1606: [65253, 65254, 65255, 65256],
  1607: [65257, 65258, 65259, 65260],
  1608: [65261, 65262, 0, 0],
  1609: [65263, 65264, 64488, 64489],
  1610: [65265, 65266, 65267, 65268],
  1611: [65136, 0, 0, 65137],
  1612: [65138, 0, 0, 0],
  1613: [65140, 0, 0, 0],
  1614: [65142, 0, 0, 65143],
  1615: [65144, 0, 0, 65145],
  1616: [65146, 0, 0, 65147],
  1617: [65148, 0, 0, 65149],
  1618: [65150, 0, 0, 65151],
  1649: [64336, 64337, 0, 0],
  1655: [64477, 0, 0, 0],
  1657: [64358, 64359, 64360, 64361],
  1658: [64350, 64351, 64352, 64353],
  1659: [64338, 64339, 64340, 64341],
  1662: [64342, 64343, 64344, 64345],
  1663: [64354, 64355, 64356, 64357],
  1664: [64346, 64347, 64348, 64349],
  1667: [64374, 64375, 64376, 64377],
  1668: [64370, 64371, 64372, 64373],
  1670: [64378, 64379, 64380, 64381],
  1671: [64382, 64383, 64384, 64385],
  1672: [64392, 64393, 0, 0],
  1676: [64388, 64389, 0, 0],
  1677: [64386, 64387, 0, 0],
  1678: [64390, 64391, 0, 0],
  1681: [64396, 64397, 0, 0],
  1688: [64394, 64395, 0, 0],
  1700: [64362, 64363, 64364, 64365],
  1702: [64366, 64367, 64368, 64369],
  1705: [64398, 64399, 64400, 64401],
  1709: [64467, 64468, 64469, 64470],
  1711: [64402, 64403, 64404, 64405],
  1713: [64410, 64411, 64412, 64413],
  1715: [64406, 64407, 64408, 64409],
  1722: [64414, 64415, 0, 0],
  1723: [64416, 64417, 64418, 64419],
  1726: [64426, 64427, 64428, 64429],
  1728: [64420, 64421, 0, 0],
  1729: [64422, 64423, 64424, 64425],
  1733: [64480, 64481, 0, 0],
  1734: [64473, 64474, 0, 0],
  1735: [64471, 64472, 0, 0],
  1736: [64475, 64476, 0, 0],
  1737: [64482, 64483, 0, 0],
  1739: [64478, 64479, 0, 0],
  1740: [64508, 64509, 64510, 64511],
  1744: [64484, 64485, 64486, 64487],
  1746: [64430, 64431, 0, 0],
  1747: [64432, 64433, 0, 0],
};

/** Required lam-alef ligatures, indexed as isolated, final. */
export const LIGATURES: Record<string, [number, number]> = {
  لآ: [65269, 65270],
  لأ: [65271, 65272],
  لإ: [65273, 65274],
  لا: [65275, 65276],
};
