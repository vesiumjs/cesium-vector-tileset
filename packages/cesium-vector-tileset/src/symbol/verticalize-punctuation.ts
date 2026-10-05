import { charHasRotatedVerticalOrientation } from './script-detection';

function codePointAtStart(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    throw new Error('Expected a non-empty string.');
  }
  return codePoint;
}

export const verticalizedCharacterMap: Record<string, string> = {
  '!': '︕',
  '#': '＃',
  '$': '＄',
  '%': '％',
  '&': '＆',
  '(': '︵',
  ')': '︶',
  '*': '＊',
  '+': '＋',
  ',': '︐',
  '-': '︲',
  '.': '・',
  '/': '／',
  ':': '︓',
  ';': '︔',
  '<': '︿',
  '=': '＝',
  '>': '﹀',
  '?': '︖',
  '@': '＠',
  '[': '﹇',
  '\\': '＼',
  ']': '﹈',
  '^': '＾',
  '_': '︳',
  '`': '｀',
  '{': '︷',
  '|': '―',
  '}': '︸',
  '~': '～',
  '¢': '￠',
  '£': '￡',
  '¥': '￥',
  '¦': '￤',
  '¬': '￢',
  '¯': '￣',
  '–': '︲',
  '—': '︱',
  '‘': '﹃',
  '’': '﹄',
  '“': '﹁',
  '”': '﹂',
  '…': '︙',
  '⋯': '︙',
  '‧': '・',
  '₩': '￦',
  '、': '︑',
  '。': '︒',
  '〈': '︿',
  '〉': '﹀',
  '《': '︽',
  '》': '︾',
  '「': '﹁',
  '」': '﹂',
  '『': '﹃',
  '』': '﹄',
  '【': '︻',
  '】': '︼',
  '〔': '︹',
  '〕': '︺',
  '〖': '︗',
  '〗': '︘',
  '！': '︕',
  '（': '︵',
  '）': '︶',
  '，': '︐',
  '－': '︲',
  '．': '・',
  '：': '︓',
  '；': '︔',
  '＜': '︿',
  '＞': '﹀',
  '？': '︖',
  '［': '﹇',
  '］': '﹈',
  '＿': '︳',
  '｛': '︷',
  '｜': '―',
  '｝': '︸',
  '｟': '︵',
  '｠': '︶',
  '｡': '︒',
  '｢': '﹁',
  '｣': '﹂',
};

export function verticalizePunctuation(input: string): string {
  let output = '';

  let previousCharacter: string | undefined;
  const chars = input[Symbol.iterator]();
  let char = chars.next();
  const nextChars = input[Symbol.iterator]();
  nextChars.next();
  let nextChar = nextChars.next();

  while (!char.done) {
    const currentCharacter = char.value;
    if (currentCharacter === undefined) {
      break;
    }

    const nextCharacterCanRotate = nextChar.done
      || (nextChar.value !== undefined
        && (!charHasRotatedVerticalOrientation(codePointAtStart(nextChar.value)) || verticalizedCharacterMap[nextChar.value] !== undefined));
    const previousCharacterCanRotate = previousCharacter === undefined
      || !charHasRotatedVerticalOrientation(codePointAtStart(previousCharacter))
      || verticalizedCharacterMap[previousCharacter] !== undefined;
    const canReplacePunctuation = nextCharacterCanRotate && previousCharacterCanRotate;

    const replacement = verticalizedCharacterMap[currentCharacter];
    if (canReplacePunctuation && replacement !== undefined) {
      output += replacement;
    }
    else {
      output += currentCharacter;
    }

    previousCharacter = currentCharacter;
    char = chars.next();
    nextChar = nextChars.next();
  }

  return output;
}
