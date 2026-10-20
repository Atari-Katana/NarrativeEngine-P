import { useRef, useEffect } from 'react';
import type { RefObject } from 'react';
import { Send, Square, ImagePlus, Mic, MicOff, Check, X, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { ChatAttachmentChip } from './ChatAttachmentChip';
import type { ChatAttachment } from '../hooks/useChatAttachment';
import { GalleryPicker, GalleryArmedChips, GallerySuggestions } from './GalleryComposerBar';
import type { useGalleryMention } from '../hooks/useGalleryMention';
import { useSpeechToText } from '../hooks/useSpeechToText';

/**
 * Refactored & redesigned bottom composer row with tactile voice input (STT),
 * live in-flight audio transcription HUD, active preset selector,
 * deep-search armed badge, and responsive auto-growing input textarea.
 */
export function ChatComposer({
    input,
    inputRef,
    isStreaming,
    oocBusy,
    onInputChange,
    onKeyDown,
    onSend,
    onStop,
    attachment,
    attachmentBusy,
    onAttachFile,
    onAttachFromDataTransfer,
    onCaptionChange,
    onRemoveAttachment,
    onAppendText,
    gallery,
}: {
    input: string;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    isStreaming: boolean;
    oocBusy: boolean;
    onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onSend: () => void;
    onStop: () => void;
    attachment?: ChatAttachment | null;
    attachmentBusy?: boolean;
    onAttachFile?: (file: File) => void;
    onAttachFromDataTransfer?: (data: DataTransfer | null) => boolean;
    onCaptionChange?: (caption: string) => void;
    onRemoveAttachment?: () => void;
    onAppendText?: (text: string) => void;
    gallery?: ReturnType<typeof useGalleryMention>;
}) {
    const settings = useAppStore(s => s.settings);
    const deepArmed = useAppStore(s => s.deepArmed);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFinalSpeech = (transcript: string) => {
        if (!transcript.trim()) return;
        if (onAppendText) {
            onAppendText(transcript);
        } else if (inputRef.current) {
            const separator = input.length > 0 && !input.endsWith(' ') ? ' ' : '';
            const nextVal = input + separator + transcript.trim();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                'value'
            )?.set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(inputRef.current, nextVal);
            } else {
                inputRef.current.value = nextVal;
            }
            inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };

    const {
        isSupported: sttSupported,
        isListening: sttListening,
        interimTranscript,
        error: sttError,
        startListening,
        stopListening,
        toggleListening,
    } = useSpeechToText({
        onFinalResult: handleFinalSpeech,
    });

    // Keyboard shortcut: Alt+V to toggle STT recording
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.altKey && (e.key === 'v' || e.key === 'V')) {
                e.preventDefault();
                toggleListening();
            }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [toggleListening]);

    // Paste an image straight into the box. Only swallows the event when an
    // image was actually found, so pasting text still behaves normally.
    const handlePaste = (e: React.ClipboardEvent) => {
        if (!onAttachFromDataTransfer) return;
        if (onAttachFromDataTransfer(e.clipboardData)) e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent) => {
        if (!onAttachFromDataTransfer) return;
        if (onAttachFromDataTransfer(e.dataTransfer)) e.preventDefault();
    };

    const handleCommitInterim = () => {
        if (interimTranscript.trim()) {
            handleFinalSpeech(interimTranscript.trim());
        }
        stopListening();
    };

    return (
        <div
            data-ui="composer"
            className="px-2 sm:px-4 pb-3 sm:pb-4 pt-2 relative"
            onDrop={handleDrop}
            onDragOver={e => { if (onAttachFromDataTransfer) e.preventDefault(); }}
        >
            {gallery && (
                <>
                    <GalleryPicker
                        matches={gallery.pickerOpen ? gallery.matches : []}
                        activeIndex={gallery.activeIndex}
                        onHover={gallery.setActiveIndex}
                        onPick={gallery.pick}
                    />
                    <GalleryArmedChips armed={gallery.armed} onRemove={gallery.unarm} />
                    {!gallery.pickerOpen && (
                        <GallerySuggestions
                            suggestions={gallery.suggestions}
                            onAdd={gallery.arm}
                            onDismiss={gallery.dismissSuggestion}
                        />
                    )}
                </>
            )}
            {attachment && onCaptionChange && onRemoveAttachment && (
                <ChatAttachmentChip
                    attachment={attachment}
                    onCaptionChange={onCaptionChange}
                    onRemove={onRemoveAttachment}
                />
            )}

            {/* Live STT In-Flight Processing HUD */}
            {sttListening && (
                <div
                    data-ui="stt-processing-banner"
                    className="flex items-center gap-2.5 px-3 py-2 mb-2 text-xs bg-void-darker/95 border border-terminal/50 rounded-lg shadow-lg shadow-terminal/10 text-text-primary backdrop-blur-md animate-in fade-in slide-in-from-bottom-1 duration-200"
                >
                    {/* Live Oscillating Audio Waveform */}
                    <div className="flex items-center gap-[3px] h-3.5 px-1 shrink-0">
                        <span className="w-[3px] bg-red-500 rounded-full animate-[pulse_0.4s_ease-in-out_infinite] h-2.5" />
                        <span className="w-[3px] bg-red-400 rounded-full animate-[pulse_0.6s_ease-in-out_infinite_0.1s] h-3.5" />
                        <span className="w-[3px] bg-red-500 rounded-full animate-[pulse_0.35s_ease-in-out_infinite_0.2s] h-1.5" />
                        <span className="w-[3px] bg-red-400 rounded-full animate-[pulse_0.5s_ease-in-out_infinite_0.15s] h-3" />
                        <span className="w-[3px] bg-red-500 rounded-full animate-[pulse_0.45s_ease-in-out_infinite_0.25s] h-2" />
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-bold font-mono tracking-wider uppercase text-terminal">
                            STT Live:
                        </span>
                    </div>

                    {/* Live Hypothesized Text with Pulsing Cursor */}
                    <div className="flex-1 min-w-0 font-mono text-[12px] truncate">
                        {interimTranscript ? (
                            <span className="text-terminal font-semibold italic flex items-center gap-0.5">
                                "{interimTranscript}"
                                <span className="inline-block w-1.5 h-3 bg-terminal animate-pulse ml-0.5" />
                            </span>
                        ) : (
                            <span className="text-text-dim/70 italic flex items-center gap-1">
                                Listening... speak your action or dialogue
                                <span className="inline-block w-1.5 h-3 bg-text-dim/40 animate-pulse" />
                            </span>
                        )}
                    </div>

                    {/* In-Flight Processing Actions */}
                    <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                        {interimTranscript && (
                            <span className="text-[9px] text-terminal/70 font-mono shrink-0 animate-pulse">
                                processing...
                            </span>
                        )}
                        {interimTranscript && (
                            <button
                                type="button"
                                onClick={handleCommitInterim}
                                title="Insert current text and stop recording"
                                className="px-2 py-0.5 bg-terminal/20 hover:bg-terminal/30 border border-terminal/40 text-terminal rounded flex items-center gap-1 text-[10px] font-mono uppercase font-bold transition-all"
                            >
                                <Check size={11} />
                                <span className="hidden sm:inline">Done</span>
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={stopListening}
                            title="Cancel voice recording (Esc)"
                            className="p-1 hover:bg-void-lighter text-text-dim hover:text-red-400 rounded-full transition-colors"
                        >
                            <X size={12} />
                        </button>
                    </div>
                </div>
            )}

            {sttError && (
                <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-lg mb-2 flex items-center justify-between shadow-sm">
                    <span className="font-mono">{sttError}</span>
                    <button
                        type="button"
                        onClick={() => startListening()}
                        className="text-[10px] uppercase font-bold text-amber-300 hover:text-amber-200 ml-2 underline"
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* Main Modern Composer Container */}
            <div
                data-ui="composer-input"
                className="flex gap-1.5 border border-border/80 focus-within:border-terminal/80 focus-within:ring-1 focus-within:ring-terminal/30 bg-void/90 backdrop-blur-md transition-all items-end p-1.5 rounded-lg shadow-sm"
            >
                {/* Preset Selector Pill */}
                <div className="relative shrink-0 mb-[3px] ml-0.5">
                    <div className="flex items-center gap-1 bg-surface/90 hover:bg-surface border border-border/80 text-text-dim hover:text-terminal hover:border-terminal/50 pl-2 pr-6 h-[34px] rounded-md transition-all cursor-pointer">
                        <Sparkles size={11} className="text-terminal/70 shrink-0" />
                        <select
                            value={settings.activePresetId}
                            onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)}
                            className="bg-transparent text-text-dim hover:text-terminal text-[10px] uppercase tracking-widest focus:outline-none max-w-[110px] sm:max-w-[140px] truncate cursor-pointer appearance-none font-bold"
                            title="Active AI Preset"
                        >
                            {settings.presets.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                    </div>
                    <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                    </svg>
                </div>

                {deepArmed && (
                    <div className="shrink-0 mb-[4px] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest bg-amber-500/15 text-amber-400 border border-amber-500/40 rounded animate-pulse">
                        Deep
                    </div>
                )}

                {/* File Attachment Hidden Input */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) onAttachFile?.(file);
                        e.target.value = '';
                    }}
                />

                {/* Image Upload Button */}
                {onAttachFile && (
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isStreaming || attachmentBusy || !!attachment}
                        title={attachment ? 'One image at a time — remove the current one first' : 'Attach an image (or paste one)'}
                        className="h-[34px] w-[34px] mb-[3px] rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 text-text-dim hover:text-terminal hover:bg-terminal/10"
                    >
                        <ImagePlus size={16} />
                    </button>
                )}

                {/* Tactile STT Voice Dictation Button */}
                <button
                    type="button"
                    onClick={toggleListening}
                    disabled={isStreaming}
                    title={
                        !sttSupported
                            ? 'Speech-to-text not supported in this browser (use Chrome, Edge, or Safari)'
                            : sttListening
                                ? 'Stop voice recording (Alt+V)'
                                : 'Voice input (Speech-to-Text) [Alt+V]'
                    }
                    className={`h-[34px] w-[34px] mb-[3px] rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 relative ${
                        sttListening
                            ? 'text-red-400 bg-red-500/20 border border-red-500/50 shadow-[0_0_10px_rgba(239,68,68,0.4)] animate-pulse'
                            : 'text-text-dim hover:text-terminal hover:bg-terminal/10'
                    }`}
                >
                    {sttListening ? (
                        <>
                            <MicOff size={16} />
                            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                        </>
                    ) : (
                        <Mic size={16} />
                    )}
                </button>

                {/* Auto-growing Textarea */}
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={e => { onInputChange(e); gallery?.syncFromTextarea(); }}
                    onKeyDown={e => {
                        // The picker claims Enter/Tab/arrows while it is open, so
                        // Enter selects a match instead of sending the message.
                        if (gallery?.handleKeyDown(e)) return;
                        onKeyDown(e);
                    }}
                    onKeyUp={() => gallery?.syncFromTextarea()}
                    onClick={() => gallery?.syncFromTextarea()}
                    onPaste={handlePaste}
                    placeholder={sttListening ? "Listening... speak now..." : "What do you do?"}
                    className="flex-1 bg-transparent px-2.5 py-2 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                />

                {/* Primary Action Button (Send / Stop) */}
                <button
                    onClick={isStreaming ? onStop : onSend}
                    disabled={!isStreaming && ((!input.trim() && !attachment?.caption.trim()) || oocBusy || !!attachmentBusy)}
                    className={`h-[34px] w-[46px] mb-[3px] rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 font-bold ${
                        isStreaming
                            ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30'
                            : 'text-terminal bg-terminal/10 hover:bg-terminal/20 border border-terminal/30 shadow-sm'
                    }`}
                >
                    {isStreaming ? <Square size={15} fill="currentColor" /> : <Send size={15} />}
                </button>
            </div>
        </div>
    );
}
