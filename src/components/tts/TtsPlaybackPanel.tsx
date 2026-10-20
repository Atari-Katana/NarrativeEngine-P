import { useRef, useEffect } from 'react';
import { Loader2, Volume2, Play, Pause, RotateCw, Trash2, Gauge, X } from 'lucide-react';
import { chunkSentencesForTTS, splitWords } from '../../services/tts/proseStripper';

/**
 * Enhanced Karaoke TTS playback panel — sticky glassmorphic status/controls header
 * with segmented audio buffer progress, equalizer visualization, and highlight-synced
 * auto-scrolling transcript.
 */
export function TtsPlaybackPanel({
    prose,
    ttsLoading,
    ttsPaused,
    ttsPlaying,
    ttsFinished,
    activeSentenceIdx,
    activeWordIdx,
    playbackRate,
    totalChunks,
    generatedChunks,
    onPauseResume,
    onSpeedChange,
    onSpeak,
    onWipe,
    onSentenceClick,
    onClose,
}: {
    prose: string;
    ttsLoading: boolean;
    ttsPaused: boolean;
    ttsPlaying: boolean;
    ttsFinished: boolean;
    activeSentenceIdx: number;
    activeWordIdx: number;
    playbackRate: number;
    totalChunks: number;
    generatedChunks: number;
    onPauseResume: () => void;
    onSpeedChange: (delta: number) => void;
    onSpeak: () => void;
    onWipe: () => void;
    onSentenceClick: (sentenceIndex: number) => void;
    onClose?: () => void;
}) {
    const isActivelySpeaking = ttsPlaying && !ttsPaused;

    return (
        <div
            data-ui="tts-playback-panel"
            className="mb-2 rounded-lg border border-terminal/30 bg-void-darker/90 backdrop-blur-md shadow-md shadow-terminal/5 max-h-[135px] overflow-hidden flex flex-col transition-all"
        >
            {/* Sticky Modern Audio Console Header */}
            <div className="z-10 bg-void-darker border-b border-terminal/20 px-2.5 py-1.5 flex flex-col gap-1 shrink-0">
                <div className="flex items-center gap-2 justify-between min-w-0">
                    {/* Status Pill with Visual Equalizer */}
                    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink">
                        <div
                            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold font-mono tracking-wider uppercase transition-colors ${
                                isActivelySpeaking
                                    ? 'bg-terminal/20 text-terminal border border-terminal/40 shadow-[0_0_8px_rgba(167,139,250,0.3)]'
                                    : ttsLoading
                                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 animate-pulse'
                                        : ttsPaused
                                            ? 'bg-ice-dim/20 text-ice-dim border border-border'
                                            : ttsFinished
                                                ? 'bg-terminal/10 text-terminal/80 border border-terminal/20'
                                                : 'bg-void text-text-dim border border-border'
                            }`}
                        >
                            {ttsLoading ? (
                                <Loader2 size={11} className="animate-spin text-amber-400" />
                            ) : isActivelySpeaking ? (
                                <div className="flex items-center gap-[2px] h-3">
                                    <span className="w-[2px] bg-terminal rounded-full animate-[pulse_0.6s_ease-in-out_infinite] h-2" />
                                    <span className="w-[2px] bg-terminal rounded-full animate-[pulse_0.4s_ease-in-out_infinite_0.15s] h-3" />
                                    <span className="w-[2px] bg-terminal rounded-full animate-[pulse_0.7s_ease-in-out_infinite_0.3s] h-1.5" />
                                    <span className="w-[2px] bg-terminal rounded-full animate-[pulse_0.5s_ease-in-out_infinite_0.1s] h-2.5" />
                                </div>
                            ) : ttsFinished ? (
                                <RotateCw size={11} />
                            ) : ttsPaused ? (
                                <Pause size={11} />
                            ) : (
                                <Volume2 size={11} />
                            )}
                            <span>
                                {ttsLoading
                                    ? 'Synthesizing'
                                    : isActivelySpeaking
                                        ? 'Narrating'
                                        : ttsPaused
                                            ? 'Paused'
                                            : ttsFinished
                                                ? 'Finished'
                                                : 'Voice Ready'}
                            </span>
                        </div>

                        {/* Chunk Progress Badge */}
                        {totalChunks > 0 && (
                            <span className="text-[10px] font-mono text-text-dim flex items-center gap-1.5">
                                <span className="font-semibold text-text-primary">
                                    {ttsFinished ? totalChunks : Math.max(0, activeSentenceIdx + 1)}/{totalChunks}
                                </span>
                                {generatedChunks < totalChunks && (
                                    <span className="text-amber-400/90 flex items-center gap-1 text-[9px]">
                                        <Loader2 size={9} className="animate-spin" /> buf {generatedChunks}/{totalChunks}
                                    </span>
                                )}
                            </span>
                        )}

                        <span className="text-[9px] text-text-dim/50 italic hidden sm:inline">
                            click a sentence to jump
                        </span>
                    </div>

                    {/* Playback Action Controls */}
                    <div className="flex items-center gap-1.5 ml-auto">
                        {/* Play/Pause/Resume Main Button */}
                        {ttsPlaying && (
                            <button
                                title={ttsPaused ? 'Resume playback' : 'Pause playback'}
                                onClick={onPauseResume}
                                className={`px-2.5 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-bold font-mono uppercase tracking-wider transition-all ${
                                    ttsPaused
                                        ? 'bg-terminal/20 text-terminal border border-terminal/40 hover:bg-terminal/30'
                                        : 'bg-void-lighter text-text-primary border border-border hover:border-terminal/50'
                                }`}
                            >
                                {ttsPaused ? <Play size={11} fill="currentColor" /> : <Pause size={11} />}
                                <span>{ttsPaused ? 'Resume' : 'Pause'}</span>
                            </button>
                        )}

                        {/* Replay */}
                        {ttsFinished && (
                            <button
                                title="Replay voice narration"
                                onClick={onSpeak}
                                className="px-2.5 py-1 rounded-full bg-terminal/15 border border-terminal/30 text-terminal hover:bg-terminal/25 flex items-center gap-1.5 text-[10px] font-bold font-mono uppercase tracking-wider transition-all"
                            >
                                <Play size={11} fill="currentColor" />
                                <span>Replay</span>
                            </button>
                        )}

                        {/* Speed Cycle Control */}
                        <div className="flex items-center gap-0.5 bg-void-lighter border border-border/80 px-1 py-0.5 rounded-full text-[10px] font-mono">
                            <Gauge size={11} className="text-text-dim ml-0.5 mr-0.5" />
                            <button
                                title="Slower (decrease speed)"
                                onClick={() => onSpeedChange(-0.25)}
                                className="px-1 py-0.5 text-text-dim hover:text-terminal transition-colors"
                            >
                                −
                            </button>
                            <span className="w-8 text-center font-bold text-text-primary">
                                {playbackRate.toFixed(2)}×
                            </span>
                            <button
                                title="Faster (increase speed)"
                                onClick={() => onSpeedChange(0.25)}
                                className="px-1 py-0.5 text-text-dim hover:text-terminal transition-colors"
                            >
                                +
                            </button>
                        </div>

                        {/* Wipe/Delete Audio Cache */}
                        <button
                            title="Delete cached audio files for this message"
                            onClick={onWipe}
                            className="p-1.5 text-text-dim hover:text-red-400 transition-colors rounded-full hover:bg-red-500/10"
                        >
                            <Trash2 size={12} />
                        </button>

                        {/* Optional Close Panel */}
                        {onClose && (
                            <button
                                title="Dismiss karaoke player"
                                onClick={onClose}
                                className="p-1.5 text-text-dim hover:text-text-primary transition-colors rounded-full hover:bg-void-lighter"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Segmented Timeline Progress Bar */}
                {totalChunks > 0 && (
                    <div className="w-full h-1 bg-void rounded-full overflow-hidden flex gap-[2px]">
                        {Array.from({ length: totalChunks }).map((_, i) => {
                            const isCurrent = i === activeSentenceIdx && !ttsFinished;
                            const isDone = i < activeSentenceIdx || ttsFinished;
                            const isBuffered = i < generatedChunks;

                            return (
                                <div
                                    key={i}
                                    title={`Sentence ${i + 1}/${totalChunks}`}
                                    className={`flex-1 h-full rounded-full transition-all duration-300 ${
                                        isCurrent
                                            ? 'bg-terminal shadow-[0_0_6px_rgba(167,139,250,0.8)]'
                                            : isDone
                                                ? 'bg-terminal/70'
                                                : isBuffered
                                                    ? 'bg-terminal/25'
                                                    : 'bg-border/30'
                                    }`}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Scrollable Karaoke Transcript with Highlight Sync */}
            <div className="p-2 sm:px-2.5 overflow-y-auto max-h-[75px] font-sans selection:bg-terminal/30">
                <KaraokeText
                    prose={prose}
                    sentenceIdx={activeSentenceIdx}
                    wordIdx={activeWordIdx}
                    finished={ttsFinished}
                    generatedChunks={generatedChunks}
                    onSentenceClick={onSentenceClick}
                />
            </div>
        </div>
    );
}

/**
 * Karaoke-style prose renderer for TTS highlight sync.
 * Each sentence is clickable (jumps playback to that chunk).
 * Auto-scrolls smoothly to keep the active sentence visible.
 */
export function KaraokeText({
    prose,
    sentenceIdx,
    wordIdx,
    finished,
    generatedChunks = 0,
    onSentenceClick,
}: {
    prose: string;
    sentenceIdx: number;
    wordIdx: number;
    finished?: boolean;
    generatedChunks?: number;
    onSentenceClick?: (sentenceIndex: number) => void;
}) {
    const sentences = chunkSentencesForTTS(prose);
    const isInteractive = !!onSentenceClick && (sentenceIdx >= 0 || finished);
    const activeSentenceRef = useRef<HTMLSpanElement | null>(null);

    // Auto-scroll the active sentence into view inside the panel
    useEffect(() => {
        if (activeSentenceRef.current) {
            activeSentenceRef.current.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
            });
        }
    }, [sentenceIdx]);

    return (
        <div className={`text-xs leading-relaxed transition-opacity ${finished ? 'text-text-dim/60' : 'text-text-primary'}`}>
            {sentences.map((sent, si) => {
                const words = splitWords(sent);
                const isPast = sentenceIdx >= 0 && si < sentenceIdx;
                const isActive = si === sentenceIdx && !finished;
                const isGenerated = si < generatedChunks || finished;
                const canClick = isInteractive && isGenerated;

                return (
                    <span
                        key={si}
                        ref={isActive ? activeSentenceRef : null}
                        onClick={canClick ? () => onSentenceClick!(si) : undefined}
                        className={`inline-block my-0.5 rounded transition-all ${
                            isActive
                                ? 'bg-terminal/10 border-l-2 border-terminal pl-1.5 pr-1 py-0.5 rounded-r shadow-sm'
                                : isPast || finished
                                    ? 'text-text-dim/40'
                                    : !isGenerated
                                        ? 'text-text-dim/30 italic'
                                        : 'text-text-primary'
                        } ${canClick ? 'cursor-pointer hover:bg-terminal/20 hover:text-terminal' : ''}`}
                    >
                        {words.map((w, wi) => {
                            const isWordActive = isActive && wi === wordIdx;
                            return (
                                <span
                                    key={wi}
                                    className={`transition-all duration-150 ${
                                        isWordActive
                                            ? 'bg-terminal text-void font-bold px-1 py-0.5 rounded shadow-[0_0_8px_rgba(167,139,250,0.6)]'
                                            : isActive
                                                ? 'text-text-primary'
                                                : ''
                                    }`}
                                >
                                    {w}{' '}
                                </span>
                            );
                        })}
                    </span>
                );
            })}
        </div>
    );
}
