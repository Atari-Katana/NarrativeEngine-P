import { useState, useRef, useEffect, useCallback } from 'react';

// Type definitions for Web Speech API
interface SpeechRecognitionResultItem {
    transcript: string;
    confidence: number;
}

interface SpeechRecognitionResultLike {
    isFinal: boolean;
    length: number;
    [index: number]: SpeechRecognitionResultItem;
}

interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: {
        length: number;
        [index: number]: SpeechRecognitionResultLike;
    };
}

interface SpeechRecognitionErrorEventLike {
    error: string;
    message?: string;
}

interface SpeechRecognitionInstance {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start: () => void;
    stop: () => void;
    abort: () => void;
    onstart: (() => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
    if (typeof window === 'undefined') return null;
    const win = window as unknown as {
        SpeechRecognition?: SpeechRecognitionConstructor;
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export type UseSpeechToTextOptions = {
    lang?: string;
    onFinalResult?: (transcript: string) => void;
};

export function useSpeechToText(options?: UseSpeechToTextOptions) {
    const { lang = 'en-US', onFinalResult } = options || {};

    const [isListening, setIsListening] = useState(false);
    const [interimTranscript, setInterimTranscript] = useState('');
    const [error, setError] = useState<string | null>(null);

    const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
    const onFinalResultRef = useRef(onFinalResult);
    onFinalResultRef.current = onFinalResult;

    const isSupported = typeof window !== 'undefined' && !!getSpeechRecognitionConstructor();

    const stopListening = useCallback(() => {
        if (recognitionRef.current) {
            try {
                recognitionRef.current.stop();
            } catch {
                // Ignore already stopped errors
            }
        }
        setIsListening(false);
        setInterimTranscript('');
    }, []);

    const startListening = useCallback(() => {
        const RecognitionClass = getSpeechRecognitionConstructor();
        if (!RecognitionClass) {
            setError('Speech recognition is not supported in this browser.');
            return;
        }

        // Stop any existing instance
        if (recognitionRef.current) {
            try {
                recognitionRef.current.abort();
            } catch {
                // Ignore
            }
        }

        setError(null);
        setInterimTranscript('');

        try {
            const recognition = new RecognitionClass();
            recognition.continuous = true;
            recognition.interimResults = true; // Crucial for live in-flight processing display
            recognition.lang = lang;

            recognition.onstart = () => {
                setIsListening(true);
                setError(null);
            };

            recognition.onresult = (event: SpeechRecognitionEventLike) => {
                let interim = '';

                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    const res = event.results[i];
                    const text = res[0]?.transcript || '';

                    if (res.isFinal) {
                        if (text.trim() && onFinalResultRef.current) {
                            onFinalResultRef.current(text.trim());
                        }
                    } else {
                        interim += text;
                    }
                }

                setInterimTranscript(interim.trim());
            };

            recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
                // 'no-speech' is common when pausing, don't show full alert
                if (event.error === 'no-speech') {
                    return;
                }
                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                    setError('Microphone access was denied. Please allow microphone access in your browser.');
                } else {
                    setError(`Speech recognition error: ${event.error}`);
                }
                setIsListening(false);
                setInterimTranscript('');
            };

            recognition.onend = () => {
                setIsListening(false);
                setInterimTranscript('');
            };

            recognition.start();
            recognitionRef.current = recognition;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`Failed to start speech recognition: ${msg}`);
            setIsListening(false);
            setInterimTranscript('');
        }
    }, [lang]);

    const toggleListening = useCallback(() => {
        if (isListening) {
            stopListening();
        } else {
            startListening();
        }
    }, [isListening, startListening, stopListening]);

    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                try {
                    recognitionRef.current.abort();
                } catch {
                    // Ignore
                }
            }
        };
    }, []);

    return {
        isSupported,
        isListening,
        interimTranscript,
        error,
        startListening,
        stopListening,
        toggleListening,
    };
}
