import { describe, it, expect } from 'vitest';
import { proseForTTS, chunkSentencesForTTS, splitWords } from '../proseStripper';

describe('proseStripper', () => {
    describe('proseForTTS', () => {
        it('strips <think>...</think> blocks from output', () => {
            const input = '<think>I should set a mysterious tone.</think>The tavern door opens slowly.';
            expect(proseForTTS(input)).toBe('The tavern door opens slowly.');
        });

        it('strips movement HTML comments', () => {
            const input = '<!-- MOVEMENT to tavern -->You step inside from the cold.';
            expect(proseForTTS(input)).toBe('You step inside from the cold.');
        });

        it('strips Scene headers and NPC name brackets', () => {
            const input = 'Scene #5 | The Crossroads\n\n[**Eldrin**] says, "Welcome, traveler."';
            expect(proseForTTS(input)).toBe('The Crossroads Eldrin says, "Welcome, traveler."');
        });

        it('strips system tags such as [SCENE_STAKES: ...]', () => {
            const input = 'Thunder crashes in the distance. [SCENE_STAKES: Danger level is high] Rain pours down.';
            expect(proseForTTS(input)).toBe('Thunder crashes in the distance. Rain pours down.');
        });

        it('strips markdown formatting symbols (bold, italic, headers, blockquotes)', () => {
            const input = '### The *Ancient* Library\n> "Knowledge is **power**," reads the inscription.';
            expect(proseForTTS(input)).toBe('The Ancient Library "Knowledge is power," reads the inscription.');
        });
    });

    describe('chunkSentencesForTTS', () => {
        it('returns empty array for empty or whitespace text', () => {
            expect(chunkSentencesForTTS('')).toEqual([]);
            expect(chunkSentencesForTTS('   ')).toEqual([]);
        });

        it('splits sentences and groups them within maxLen', () => {
            const prose = 'First short sentence. Second short sentence. Third short sentence.';
            const chunks = chunkSentencesForTTS(prose, 50);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            for (const chunk of chunks) {
                expect(chunk.length).toBeLessThanOrEqual(50);
            }
        });

        it('preserves single long sentences even if exceeding maxLen', () => {
            const longSentence = 'This is an exceptionally long sentence designed to exceed the normal threshold limit for an individual chunk in text to speech.';
            const chunks = chunkSentencesForTTS(longSentence, 40);
            expect(chunks.length).toBe(1);
            expect(chunks[0]).toBe(longSentence);
        });
    });

    describe('splitWords', () => {
        it('splits sentences into individual words while filtering whitespace', () => {
            const words = splitWords('Hello,   brave   adventurer!');
            expect(words).toEqual(['Hello,', 'brave', 'adventurer!']);
        });
    });
});
