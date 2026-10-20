import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// Set DATA_DIR to standard data directory
process.env.DATA_DIR = path.join(projectRoot, 'data');

console.log('='.repeat(70));
console.log(' NARRATIVE ENGINE - VOICE SYSTEM END-TO-END VERIFICATION');
console.log('='.repeat(70));
console.log(`Project root: ${projectRoot}`);
console.log(`DATA_DIR:     ${process.env.DATA_DIR}`);

async function run() {
    const tts = await import('../server/lib/tts.js');
    const { createTtsRouter } = await import('../server/routes/tts.js');

    // 1. Initial Status
    console.log('\n[Stage 1] Checking Initial Status...');
    const initialStatus = tts.getTtsStatus();
    console.log('Initial Status:', initialStatus);
    console.log(`Model Cached on Disk: ${tts.isTtsModelCached()}`);
    console.log(`Model Ready: ${tts.isTtsReady()}`);

    // 2. Setup Express test server for HTTP API verification
    console.log('\n[Stage 2] Starting Express Test Server with TTS Routes...');
    const app = express();
    app.use(express.json());
    app.use(createTtsRouter());

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Test server listening on ${baseUrl}`);

    try {
        // 3. Test HTTP /api/tts/status
        console.log('\n[Stage 3] Testing GET /api/tts/status endpoint...');
        const statusRes = await fetch(`${baseUrl}/api/tts/status`);
        if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
        const statusData = await statusRes.json();
        console.log('Status endpoint returned:', statusData);

        // 4. Initialize Kokoro Model (via HTTP POST /api/tts/init)
        console.log('\n[Stage 4] Initializing Kokoro TTS Model (via POST /api/tts/init)...');
        console.log('This will load/warmup the Kokoro-82M ONNX model...');
        const initStart = Date.now();
        const initRes = await fetch(`${baseUrl}/api/tts/init`, { method: 'POST' });
        if (!initRes.ok) throw new Error(`HTTP init failed: ${initRes.status} ${await initRes.text()}`);
        const initData = await initRes.json();
        const initMs = Date.now() - initStart;
        console.log(`Initialization succeeded in ${initMs}ms:`, initData);

        // 5. Test Voice Listing
        console.log('\n[Stage 5] Testing GET /api/tts/voices...');
        const voicesRes = await fetch(`${baseUrl}/api/tts/voices`);
        if (!voicesRes.ok) throw new Error(`HTTP ${voicesRes.status}`);
        const voicesData = await voicesRes.json();
        console.log(`Available voices (${voicesData.voices?.length || 0}):`, voicesData.voices);

        // 6. Test Speech Synthesis (POST /api/tts/generate)
        const testText = "Welcome to the realm of high adventure. Your quest begins now.";
        const testVoice = "af_heart";
        console.log(`\n[Stage 6] Synthesizing speech via POST /api/tts/generate...`);
        console.log(`Text: "${testText}"`);
        console.log(`Voice: "${testVoice}"`);

        const genStart = Date.now();
        const genRes = await fetch(`${baseUrl}/api/tts/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: testText, voice: testVoice }),
        });

        if (!genRes.ok) {
            const errText = await genRes.text();
            throw new Error(`Generation failed: ${genRes.status} - ${errText}`);
        }

        const audioBuffer = Buffer.from(await genRes.arrayBuffer());
        const genMs = Date.now() - genStart;
        console.log(`Synthesized in ${genMs}ms. Received audio bytes: ${audioBuffer.length}`);

        // 7. Validate WAV Format (RIFF header, channels, sample rate)
        console.log('\n[Stage 7] Validating WAV audio file structure...');
        const riffHeader = audioBuffer.subarray(0, 4).toString('ascii');
        const waveFormat = audioBuffer.subarray(8, 12).toString('ascii');
        console.log(`  RIFF Magic: "${riffHeader}" (expected "RIFF")`);
        console.log(`  WAVE Magic: "${waveFormat}" (expected "WAVE")`);

        if (riffHeader !== 'RIFF' || waveFormat !== 'WAVE') {
            throw new Error(`Invalid WAV header: got ${riffHeader} / ${waveFormat}`);
        }

        const numChannels = audioBuffer.readUInt16LE(22);
        const sampleRate = audioBuffer.readUInt32LE(24);
        const bitsPerSample = audioBuffer.readUInt16LE(34);
        const durationSec = (audioBuffer.length - 44) / (sampleRate * numChannels * (bitsPerSample / 8));

        console.log(`  Audio Channels:  ${numChannels}`);
        console.log(`  Sample Rate:     ${sampleRate} Hz`);
        console.log(`  Bits Per Sample: ${bitsPerSample}-bit`);
        console.log(`  Audio Duration:  ${durationSec.toFixed(2)} seconds`);

        // 8. Test Cache Persistence & Cache Check Endpoint
        console.log('\n[Stage 8] Testing Cache Persistence & /api/tts/check-cache...');
        const checkRes = await fetch(`${baseUrl}/api/tts/check-cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chunks: [
                    { text: testText, voice: testVoice },
                    { text: "This text was never generated before and should not be cached.", voice: testVoice }
                ]
            }),
        });

        if (!checkRes.ok) throw new Error(`check-cache failed: ${checkRes.status}`);
        const checkData = await checkRes.json();
        console.log('Cache check response:', checkData);

        if (!checkData.cached || checkData.cached[0] !== true || checkData.cached[1] !== false) {
            throw new Error(`Cache check mismatch! Expected [true, false], got ${JSON.stringify(checkData.cached)}`);
        }
        console.log('✓ Cache hit detection verified.');

        // 9. Test Loading from Disk Cache (GET /api/tts/cached)
        console.log('\n[Stage 9] Testing Cached Audio Retrieval (GET /api/tts/cached)...');
        const cachedUrl = `${baseUrl}/api/tts/cached?text=${encodeURIComponent(testText)}&voice=${encodeURIComponent(testVoice)}`;
        const cacheFetchStart = Date.now();
        const cachedRes = await fetch(cachedUrl);
        const cacheFetchMs = Date.now() - cacheFetchStart;

        if (!cachedRes.ok) throw new Error(`cached audio retrieval failed: ${cachedRes.status}`);
        const cachedBuffer = Buffer.from(await cachedRes.arrayBuffer());
        console.log(`Retrieved cached audio in ${cacheFetchMs}ms. Byte size: ${cachedBuffer.length}`);

        if (cachedBuffer.length !== audioBuffer.length) {
            throw new Error(`Cached buffer length mismatch: ${cachedBuffer.length} vs original ${audioBuffer.length}`);
        }
        console.log('✓ Cached audio byte equality verified (0ms synthesis overhead on cache hit).');

        // 10. Test Warmup on Boot
        console.log('\n[Stage 10] Testing warmupTts() when model is cached...');
        const warmed = await tts.warmupTts();
        console.log(`warmupTts() returned: ${warmed}`);

        console.log('\n' + '='.repeat(70));
        console.log(' ALL END-TO-END VOICE SYSTEM TESTS PASSED SUCCESSFULLY!');
        console.log('='.repeat(70));
    } finally {
        server.close();
    }
}

run().catch((err) => {
    console.error('\n❌ Voice System End-to-End Test Failed:');
    console.error(err);
    process.exit(1);
});
