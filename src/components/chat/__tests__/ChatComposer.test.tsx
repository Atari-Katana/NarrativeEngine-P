import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChatComposer } from '../ChatComposer';

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

describe('ChatComposer - STT Live Transcription', () => {
    beforeEach(() => {
        MockSpeechRecognition.instances = [];
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
    });

    it('renders microphone button and displays live in-flight STT text when listening', () => {
        const inputRef = { current: null };
        const onInputChange = vi.fn();
        const onAppendText = vi.fn();

        render(
            <ChatComposer
                input=""
                inputRef={inputRef}
                isStreaming={false}
                oocBusy={false}
                onInputChange={onInputChange}
                onKeyDown={vi.fn()}
                onSend={vi.fn()}
                onStop={vi.fn()}
                onAppendText={onAppendText}
            />
        );

        // Find the mic button
        const micButton = screen.getByTitle(/Voice input \(Speech-to-Text\)/i);
        expect(micButton).toBeDefined();

        // Banner should not be visible before clicking mic
        expect(screen.queryByText(/STT Live:/i)).toBeNull();

        // Click to start listening
        act(() => {
            fireEvent.click(micButton);
        });

        // Banner should now be visible
        expect(screen.getByText(/STT Live:/i)).toBeDefined();
        expect(screen.getByText(/Listening... speak your action or dialogue/i)).toBeDefined();

        // Simulate interim STT speech processing
        const instance = MockSpeechRecognition.instances[0];
        act(() => {
            instance.onresult?.({
                resultIndex: 0,
                results: [
                    {
                        isFinal: false,
                        length: 1,
                        0: { transcript: 'I draw my sword', confidence: 0.88 },
                    },
                ],
            });
        });

        // Should display the in-flight text as it is being processed
        expect(screen.getByText(/"I draw my sword"/i)).toBeDefined();
        expect(screen.getByText(/processing.../i)).toBeDefined();

        // Simulate finalized transcript
        act(() => {
            instance.onresult?.({
                resultIndex: 0,
                results: [
                    {
                        isFinal: true,
                        length: 1,
                        0: { transcript: 'I draw my sword.', confidence: 0.99 },
                    },
                ],
            });
        });

        expect(onAppendText).toHaveBeenCalledWith('I draw my sword.');
    });
});
