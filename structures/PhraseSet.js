const PARSE_WORDS_REGEX = /\w+(['-]\w+)*/g;
const SPLIT_WORDS_REGEX = /[^\s+]+/g;
const START_SYMBOL = '(';
const END_SYMBOL = ')';
const WORD_PAIR_SEPARATOR = '+';

export default class PhraseSet {
    static getWords(phrase) {
        phrase = phrase.toLowerCase();
        let words = phrase.match(PARSE_WORDS_REGEX);
        let split = phrase.match(SPLIT_WORDS_REGEX);

        if (!words || !split || words.length !== split.length || words.join() !== split.join()) {
            return;
        }

        return words;
    }

    constructor(phrases) {
        this._lookup = new Map();
        this._set = new Set();
        this.phrases = [];
        this.wordCount = 0;

        if (phrases) {
            for (const phrase of phrases) {
                this.addPhrase(phrase);
            }
        }
    }

    getPhraseSlice(phrase) {
        let words = PhraseSet.getWords(phrase);
        if (!words) {
            return false;
        }

        let slice = [];
        let sliceSize0 = 1;
        let sliceSize1 = 1;

        let wordIdx = 0;

        let first = true;

        for (let i = 0; i < words.length; i++) {
            slice[0] = undefined;
            slice[1] = START_SYMBOL;
            slice.length = 2;

            sliceSize0 = 1;
            sliceSize1 = 1;
            wordIdx = i;

            first = true;

            do {
                slice.copyWithin(0, sliceSize0);
                sliceSize0 = sliceSize1;

                if (first) {
                    first = false;
                } else {
                    slice[sliceSize0] = END_SYMBOL;
                    slice.length = sliceSize0 + 1;

                    if (this._lookup.has(slice.join(WORD_PAIR_SEPARATOR))) {
                        return words.slice(i, wordIdx + 1);
                    }
                }

                if (wordIdx === words.length) {
                    break;
                } else {
                    sliceSize1 = this._updateSlice(wordIdx, sliceSize0, words, slice);
                    wordIdx += sliceSize1;
                }
            } while (this._lookup.has(slice.join(WORD_PAIR_SEPARATOR)));
        }
    }

    addPhrase(phrase) {
        let words = PhraseSet.getWords(phrase);
        if (!words) {
            return false;
        }

        for (const word of words) {
            if (word.length > 100) {
                return false;
            }
        }

        phrase = words.join(" ");

        if (this._set.has(phrase)) {
            return false;
        }

        this._updateWords(words, 1);

        this._set.add(phrase);
        this.phrases.push(phrase);
        this.wordCount += words.length;
        return true;
    }

    removePhrase(phrase) {
        let words = PhraseSet.getWords(phrase);
        if (!words) {
            return false;
        }

        phrase = words.join(" ");

        if (!this._set.has(phrase)) {
            return false;
        }

        this._updateWords(words, -1);

        this._set.delete(phrase);
        this.phrases.splice(this.phrases.indexOf(phrase), 1);
        this.wordCount -= words.length;
        return true;
    }

    _updateWords(words, inc) {
        let slice = [undefined, START_SYMBOL];
        let sliceSize0 = 1;
        let sliceSize1 = 1;

        let wordIdx = 0;

        do {
            slice.copyWithin(0, sliceSize0);
            sliceSize0 = sliceSize1;
            sliceSize1 = this._updateSlice(wordIdx, sliceSize0, words, slice);
            wordIdx += sliceSize1;

            let key = slice.join(WORD_PAIR_SEPARATOR);
            let val = (this._lookup.get(key) || 0) + inc;
            if (val === 0) {
                this._lookup.delete(key);
            } else {
                this._lookup.set(key, val);
            }
        } while (wordIdx < words.length);

        slice.copyWithin(0, sliceSize0);
        slice[sliceSize1] = END_SYMBOL;
        slice.length = sliceSize1 + 1;

        let key = slice.join(WORD_PAIR_SEPARATOR);
        let val = (this._lookup.get(key) || 0) + inc;
        if (val === 0) {
            this._lookup.delete(key);
        } else {
            this._lookup.set(key, val);
        }
    }

    _updateSlice(wordIdx, sliceSize0, words, slice) {
        let sliceSize1 = 0;
        let wordGathering = words[wordIdx];

        do {
            slice[sliceSize0 + sliceSize1] = wordGathering;
            sliceSize1++;
            wordIdx++;
        } while (words[wordIdx] === wordGathering);

        slice.length = sliceSize0 + sliceSize1;
        return sliceSize1;
    }
}