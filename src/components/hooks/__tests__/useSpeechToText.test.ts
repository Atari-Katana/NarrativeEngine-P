import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpeechToText } from '../useSpeechToText';

class MockSpeechRecognition {
    continuous = false;
    interimResults = false;
    lang = 'en-US';
    onstart: (() => void) | null = null;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: (() => void) | null = null;

    static instances: MockSpeechRecognition[] = [];

    constructor() {
        MockSpeechRecognition.instances.push(this);
    }

    start() {
        if (this.onstart) this.onstart();
    }

    stop() {
        if (this.onend) this.onend();
    }

    abort() {
        if (this.onend) this.onend();
    }
}

describe('useSpeechToText', () => {
    beforeEach(() => {
        MockSpeechRecognition.instances = [];
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
        delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports isSupported=false when SpeechRecognition is not in window', () => {
        const { result } = renderHook(() => useSpeechToText());
        expect(result.current.isSupported).toBe(false);
    });

    it('reports isSupported=true when webkitSpeechRecognition is available', () => {
        (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = MockSpeechRecognition;
        const { result } = renderHook(() => useSpeechToText());
        expect(result.current.isSupported).toBe(true);
    });

    it('starts listening and updates state', () => {
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
        const { result } = renderHook(() => useSpeechToText());

        expect(result.current.isListening).toBe(false);

        act(() => {
            result.current.startListening();
        });

        expect(result.current.isListening).toBe(true);
        expect(result.current.error).toBeNull();
    });

    it('updates interimTranscript when in-flight results are received', () => {
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
        const onFinalResult = vi.fn();
        const { result } = renderHook(() => useSpeechToText({ onFinalResult }));

        act(() => {
            result.current.startListening();
        });

        const instance = MockSpeechRecognition.instances[0];

        // Simulate interim result
        act(() => {
            instance.onresult?.({
                resultIndex: 0,
                results: [
                    {
                        isFinal: false,
                        length: 1,
                        0: { transcript: 'I walk towards', confidence: 0.9 },
                    },
                ],
            });
        });

        expect(result.current.interimTranscript).toBe('I walk towards');
        expect(onFinalResult).not.toHaveBeenCalled();
    });

    it('calls onFinalResult when speech segment is finalized', () => {
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
        const onFinalResult = vi.fn();
        const { result } = renderHook(() => useSpeechToText({ onFinalResult }));

        act(() => {
            result.current.startListening();
        });

        const instance = MockSpeechRecognition.instances[0];

        // Simulate final result
        act(() => {
            instance.onresult?.({
                resultIndex: 0,
                results: [
                    {
                        isFinal: true,
                        length: 1,
                        0: { transcript: 'I open the chest.', confidence: 0.98 },
                    },
                ],
            });
        });

        expect(onFinalResult).toHaveBeenCalledWith('I open the chest.');
    });

    it('stops listening and clears interimTranscript', () => {
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
        const { result } = renderHook(() => useSpeechToText());

        act(() => {
            result.current.startListening();
        });
        expect(result.current.isListening).toBe(true);

        act(() => {
            result.current.stopListening();
        });
        expect(result.current.isListening).toBe(false);
        expect(result.current.interimTranscript).toBe('');
    });
});
