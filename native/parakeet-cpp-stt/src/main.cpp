#include "parakeet_capi.h"
#include "ggml_graph.hpp"
#include "whisper.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <exception>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <numeric>
#include <string>
#include <vector>

static constexpr size_t SAMPLE_RATE = 16000;
static constexpr size_t VAD_CHUNK_FRAMES = 512;
static constexpr size_t VAD_CHUNK_MS = 32;
static constexpr uint8_t INPUT_AUDIO_FRAME = 1;
static constexpr uint8_t INPUT_CLOSE_USER = 2;

struct Config {
    std::string model_path;
    std::string vad_model_path;
    float vad_threshold = 0.45f;
    size_t min_silence_ms = 800;
    size_t speech_pad_ms = 250;
    size_t preroll_ms = 1800;
    size_t min_utterance_ms = 450;
    size_t interim_interval_ms = 250;
    size_t interim_min_audio_ms = 300;
    size_t interim_window_ms = 4000;
    float energy_gate = 0.002f;
};

struct InputMessage {
    uint8_t type = 0;
    std::string user_id;
    std::vector<uint8_t> payload;
};

static size_t env_size(const char* name, size_t fallback) {
    const char* value = std::getenv(name);
    return value ? static_cast<size_t>(std::strtoull(value, nullptr, 10)) : fallback;
}

static float env_float(const char* name, float fallback) {
    const char* value = std::getenv(name);
    return value ? std::strtof(value, nullptr) : fallback;
}

static std::string json_escape(const std::string& value) {
    std::string out;
    for (char c : value) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out += c;
    }
    return out;
}

class SileroVad {
public:
    explicit SileroVad(const std::string& model_path) {
        whisper_vad_context_params params = whisper_vad_default_context_params();
        params.n_threads = 1;
        params.use_gpu = false;
        ctx_ = whisper_vad_init_from_file_with_params(model_path.c_str(), params);
        if (!ctx_) throw std::runtime_error("failed to load whisper.cpp Silero VAD model: " + model_path);
        // whisper.cpp leaves the LSTM state buffer uninitialized at init; streaming
        // from garbage state pins every probability at a constant (~0.35).
        whisper_vad_reset_state(ctx_);
    }

    ~SileroVad() { whisper_vad_free(ctx_); }

    void reset() { whisper_vad_reset_state(ctx_); }

    float predict(const std::vector<float>& chunk) {
        if (!whisper_vad_detect_speech_no_reset(ctx_, chunk.data(), static_cast<int>(chunk.size()))) {
            return 0.0f;
        }
        int n = whisper_vad_n_probs(ctx_);
        float* probs = whisper_vad_probs(ctx_);
        return n > 0 ? probs[n - 1] : 0.0f;
    }

private:
    whisper_vad_context* ctx_ = nullptr;
};

struct UserState {
    explicit UserState(const std::string& vad_model_path) : vad(vad_model_path) {}

    SileroVad vad;
    std::vector<float> pending;
    std::deque<std::vector<float>> preroll;
    std::vector<std::vector<float>> utterance_chunks;
    bool in_utterance = false;
    size_t utterance_index = 0;
    size_t silence_ms = 0;
    size_t last_interim_ms = 0;
};

static bool read_exact_or_eof(char* data, size_t bytes) {
    if (bytes == 0) return true;
    if (!std::cin.read(data, static_cast<std::streamsize>(bytes))) {
        if (std::cin.eof()) return false;
        throw std::runtime_error("unexpected EOF in input frame");
    }
    return true;
}

static uint32_t read_u32_le() {
    uint8_t bytes[4];
    if (!read_exact_or_eof(reinterpret_cast<char*>(bytes), sizeof(bytes))) throw std::runtime_error("unexpected EOF in u32");
    return static_cast<uint32_t>(bytes[0]) |
           (static_cast<uint32_t>(bytes[1]) << 8) |
           (static_cast<uint32_t>(bytes[2]) << 16) |
           (static_cast<uint32_t>(bytes[3]) << 24);
}

static bool read_message(InputMessage& out) {
    char type = 0;
    if (!std::cin.read(&type, 1)) return false;
    out.type = static_cast<uint8_t>(type);
    const uint32_t user_id_bytes = read_u32_le();
    out.user_id.assign(user_id_bytes, '\0');
    if (!read_exact_or_eof(out.user_id.data(), user_id_bytes)) throw std::runtime_error("unexpected EOF in userId");
    const uint32_t payload_bytes = read_u32_le();
    out.payload.resize(payload_bytes);
    if (payload_bytes > 0 && !read_exact_or_eof(reinterpret_cast<char*>(out.payload.data()), payload_bytes)) {
        throw std::runtime_error("unexpected EOF in payload");
    }
    return true;
}

static std::vector<float> decode_pcm16(const std::vector<uint8_t>& payload) {
    if (payload.size() % 2 != 0) throw std::runtime_error("PCM frame byte length is not even");
    std::vector<float> out(payload.size() / 2);
    for (size_t i = 0; i < out.size(); ++i) {
        const uint8_t lo = payload[i * 2];
        const uint8_t hi = payload[i * 2 + 1];
        const int16_t sample = static_cast<int16_t>(static_cast<uint16_t>(lo) | (static_cast<uint16_t>(hi) << 8));
        out[i] = static_cast<float>(sample) / 32768.0f;
    }
    return out;
}

static float rms(const std::vector<float>& chunk) {
    float sum = 0.0f;
    for (float sample : chunk) sum += sample * sample;
    return std::sqrt(sum / static_cast<float>(chunk.size()));
}

static void whisper_log_silent(ggml_log_level, const char*, void*) {}

static std::string transcribe(parakeet_ctx* model, const std::vector<float>& audio) {
    char* raw = parakeet_capi_transcribe_pcm(model, audio.data(), static_cast<int>(audio.size()), SAMPLE_RATE, 0);
    if (!raw) throw std::runtime_error(parakeet_capi_last_error(model));
    std::string text(raw);
    parakeet_capi_free_string(raw);
    return text;
}

static void emit_user_event(const std::string& user_id, const std::string& json_tail) {
    std::cout << "{\"userId\":\"" << json_escape(user_id) << "\"," << json_tail << "}" << std::endl;
}

static void process_audio(
    const std::string& user_id,
    UserState& state,
    parakeet_ctx* model,
    const Config& cfg,
    const std::vector<float>& frame,
    const std::chrono::steady_clock::time_point& started
) {
    const size_t preroll_chunks = std::max<size_t>(1, cfg.preroll_ms / VAD_CHUNK_MS);
    const size_t min_frames = std::max<size_t>(1, SAMPLE_RATE * cfg.min_utterance_ms / 1000);
    const size_t interim_min_frames = std::max<size_t>(1, SAMPLE_RATE * cfg.interim_min_audio_ms / 1000);

    state.pending.insert(state.pending.end(), frame.begin(), frame.end());
    while (state.pending.size() >= VAD_CHUNK_FRAMES) {
        std::vector<float> chunk(state.pending.begin(), state.pending.begin() + VAD_CHUNK_FRAMES);
        state.pending.erase(state.pending.begin(), state.pending.begin() + VAD_CHUNK_FRAMES);
        float probability = rms(chunk) >= cfg.energy_gate ? state.vad.predict(chunk) : 0.0f;
        bool is_speech = probability >= cfg.vad_threshold;
        state.preroll.push_back(chunk);
        while (state.preroll.size() > preroll_chunks) state.preroll.pop_front();

        if (!state.in_utterance && is_speech) {
            state.in_utterance = true;
            state.utterance_index++;
            state.utterance_chunks.assign(state.preroll.begin(), state.preroll.end());
            state.silence_ms = 0;
            state.last_interim_ms = 0;
            double t = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
            emit_user_event(user_id, "\"type\":\"speech_start\",\"index\":" + std::to_string(state.utterance_index) + ",\"time\":" + std::to_string(t));
            continue;
        }
        if (!state.in_utterance) continue;

        state.utterance_chunks.push_back(chunk);
        state.silence_ms = is_speech ? 0 : state.silence_ms + VAD_CHUNK_MS;
        size_t audio_frames = 0;
        for (const auto& c : state.utterance_chunks) audio_frames += c.size();
        size_t audio_ms = audio_frames * 1000 / SAMPLE_RATE;
        if (cfg.interim_interval_ms > 0 && audio_frames >= interim_min_frames && audio_ms - state.last_interim_ms >= cfg.interim_interval_ms) {
            state.last_interim_ms = audio_ms;
        }
        if (state.silence_ms < cfg.min_silence_ms) continue;

        std::vector<float> audio;
        audio.reserve(audio_frames);
        for (const auto& c : state.utterance_chunks) audio.insert(audio.end(), c.begin(), c.end());
        double duration = static_cast<double>(audio.size()) / SAMPLE_RATE;
        if (audio.size() < min_frames) {
            emit_user_event(user_id, "\"type\":\"speech_drop\",\"index\":" + std::to_string(state.utterance_index) + ",\"duration\":" + std::to_string(duration) + ",\"reason\":\"too_short\"");
        } else {
            emit_user_event(user_id, "\"type\":\"speech_end\",\"index\":" + std::to_string(state.utterance_index) + ",\"duration\":" + std::to_string(duration));
            auto decode_start = std::chrono::steady_clock::now();
            std::string text = transcribe(model, audio);
            auto decode_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - decode_start).count();
            emit_user_event(user_id, "\"type\":\"final\",\"index\":" + std::to_string(state.utterance_index) + ",\"text\":\"" + json_escape(text) + "\",\"duration\":" + std::to_string(duration) + ",\"decodeMs\":" + std::to_string(decode_ms));
        }
        state.in_utterance = false;
        state.utterance_chunks.clear();
        state.preroll.clear();
        state.vad.reset();
    }
}

int main(int argc, char** argv) {
    try {
        Config cfg;
        const char* env_model = std::getenv("PARAKEET_CPP_MODEL_PATH");
        const char* env_vad_model = std::getenv("SILERO_VAD_GGML_MODEL_PATH");
        if (argc > 1) cfg.model_path = argv[1];
        else if (env_model) cfg.model_path = env_model;
        else throw std::runtime_error("missing GGUF model path argument or PARAKEET_CPP_MODEL_PATH");
        if (argc > 2) cfg.vad_model_path = argv[2];
        else if (env_vad_model) cfg.vad_model_path = env_vad_model;
        else throw std::runtime_error("missing Silero VAD GGML model path argument or SILERO_VAD_GGML_MODEL_PATH");
        cfg.vad_threshold = env_float("PARAKEET_VAD_THRESHOLD", cfg.vad_threshold);
        cfg.min_silence_ms = env_size("PARAKEET_MIN_SILENCE_MS", cfg.min_silence_ms);
        cfg.speech_pad_ms = env_size("PARAKEET_SPEECH_PAD_MS", cfg.speech_pad_ms);
        cfg.preroll_ms = env_size("PARAKEET_PREROLL_MS", cfg.preroll_ms);
        cfg.min_utterance_ms = env_size("PARAKEET_MIN_UTTERANCE_MS", cfg.min_utterance_ms);
        cfg.interim_interval_ms = env_size("PARAKEET_INTERIM_INTERVAL_MS", cfg.interim_interval_ms);
        cfg.interim_min_audio_ms = env_size("PARAKEET_INTERIM_MIN_AUDIO_MS", cfg.interim_min_audio_ms);
        cfg.interim_window_ms = env_size("PARAKEET_INTERIM_WINDOW_MS", cfg.interim_window_ms);
        cfg.energy_gate = env_float("PARAKEET_ENERGY_GATE", cfg.energy_gate);

        whisper_log_set(whisper_log_silent, nullptr);

        std::cerr << "loading parakeet.cpp model: " << cfg.model_path << "\n";
        parakeet_ctx* model = parakeet_capi_load(cfg.model_path.c_str());
        if (!model) throw std::runtime_error("failed to load parakeet.cpp model");

        std::cout << "{\"type\":\"ready\",\"sampleRate\":16000,\"vadChunkMs\":32,\"vadThreshold\":" << cfg.vad_threshold
                  << ",\"minSilenceMs\":" << cfg.min_silence_ms << ",\"speechPadMs\":" << cfg.speech_pad_ms
                  << ",\"prerollMs\":" << cfg.preroll_ms << ",\"interimIntervalMs\":" << cfg.interim_interval_ms
                  << ",\"interimMinAudioMs\":" << cfg.interim_min_audio_ms << ",\"interimWindowMs\":" << cfg.interim_window_ms
                  << ",\"energyGate\":" << cfg.energy_gate << "}" << std::endl;

        std::map<std::string, std::unique_ptr<UserState>> users;
        auto started = std::chrono::steady_clock::now();
        InputMessage message;
        while (read_message(message)) {
            if (message.user_id.empty()) continue;
            if (message.type == INPUT_CLOSE_USER) {
                users.erase(message.user_id);
                continue;
            }
            if (message.type != INPUT_AUDIO_FRAME) continue;
            auto it = users.find(message.user_id);
            if (it == users.end()) {
                it = users.emplace(message.user_id, std::make_unique<UserState>(cfg.vad_model_path)).first;
            }
            process_audio(message.user_id, *it->second, model, cfg, decode_pcm16(message.payload), started);
        }

        parakeet_capi_free(model);
        pk::shutdown_backend();
        return 0;
    } catch (const std::exception& e) {
        pk::shutdown_backend();
        std::cout << "{\"type\":\"error\",\"message\":\"" << json_escape(e.what()) << "\"}" << std::endl;
        return 1;
    }
}
