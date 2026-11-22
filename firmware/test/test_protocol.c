/*
 * Host 单测：不依赖 ESP-IDF，不连硬件。
 *
 * 覆盖 docs/protocol-testvectors.json 的全部 13 条用例（两端共用的唯一向量文件）：
 *   - app_to_device 合法帧：解码字段与编码结果逐字节一致，再跑命令层 reducer；
 *   - 非法帧：信封级失败（bad_magic / bad_version / bad_length / bad_checksum）
 *     与命令层拒收（退役命令 / 参数越界）；
 *   - device_to_app 帧：解码，并用对应的报告编码器逐字节复现；
 *   - chunks_hex：每一片喂给重组器，断言拼回的字节正好等于 frame_hex。
 *
 * 运行：firmware/test/run-tests.cmd（会传向量绝对路径作为 argv[1]）。
 */

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "command.h"
#include "chunk_reasm.h"
#include "protocol.h"
#include "state.h"

static int g_checks;
static int g_failures;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        ++g_checks;                                                                    \
        if (!(cond)) {                                                                 \
            fprintf(stderr, "[FAIL] %s:%d: %s\n", __FILE__, __LINE__, #cond);          \
            ++g_failures;                                                              \
        }                                                                              \
    } while (0)

#define CHECK_BYTES(actual, expected_hex, expected_len)                                \
    do {                                                                               \
        uint8_t _expected[512];                                                        \
        size_t _expected_len = hex_to_bytes((expected_hex), _expected, sizeof(_expected)); \
        ++g_checks;                                                                    \
        if (_expected_len != (size_t)(expected_len) ||                                  \
            memcmp((actual), _expected, (expected_len)) != 0) {                        \
            fprintf(stderr, "[FAIL] %s:%d: bytes mismatch\n  expect %s\n  actual ",    \
                    __FILE__, __LINE__, (expected_hex));                                \
            for (size_t _i = 0; _i < (size_t)(expected_len); ++_i) {                   \
                fprintf(stderr, "%02X", (actual)[_i]);                                 \
            }                                                                          \
            fprintf(stderr, "\n");                                                     \
            ++g_failures;                                                              \
        }                                                                              \
    } while (0)

static void report_test_count(const char *label, int before)
{
    printf("TESTCOUNT %s %d\n", label, g_checks - before);
}

#define RUN_TEST(fn)                                                                   \
    do {                                                                               \
        int _before = g_checks;                                                        \
        fn();                                                                          \
        report_test_count(#fn, _before);                                               \
    } while (0)

/* ---------------- 十六进制 ---------------- */

static size_t hex_to_bytes(const char *hex, uint8_t *out, size_t cap)
{
    size_t n = 0;
    while (*hex != '\0') {
        if (*hex == ' ' || *hex == '\n' || *hex == '\t' || *hex == '\r') {
            ++hex;
            continue;
        }
        if (n >= cap || hex[1] == '\0') {
            return (size_t)-1;
        }
        unsigned value = 0;
        if (sscanf(hex, "%2x", &value) != 1) {
            return (size_t)-1;
        }
        out[n++] = (uint8_t)value;
        hex += 2;
    }
    return n;
}

static lumen_decode_status_t decode_hex(const char *hex, lumen_frame_t *frame,
                                        uint8_t *result_code)
{
    uint8_t buf[512];
    size_t len = hex_to_bytes(hex, buf, sizeof(buf));
    if (len == (size_t)-1) {
        fprintf(stderr, "[FAIL] bad test hex: %s\n", hex);
        ++g_failures;
        return LUMEN_DECODE_SILENT;
    }
    return lumen_protocol_decode(buf, len, frame, result_code);
}

/* ---------------- 极简 JSON 扫描器 ---------------- */

static const char *json_find_key(const char *obj, const char *key)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    return strstr(obj, pattern);
}

static bool json_get_string(const char *obj, const char *key, char *out, size_t cap)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) return false;
    p = strchr(p, ':');
    if (p == NULL) return false;
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
    if (*p != '"') return false;
    ++p;
    size_t n = 0;
    while (*p != '\0' && *p != '"') {
        if (n + 1 >= cap) return false;
        out[n++] = *p++;
    }
    if (*p != '"') return false;
    out[n] = '\0';
    return true;
}

static bool json_get_int(const char *obj, const char *key, int *out)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) return false;
    p = strchr(p, ':');
    if (p == NULL) return false;
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
    if (*p == 'n') return false;
    char *end = NULL;
    long value = strtol(p, &end, 10);
    if (end == p) return false;
    *out = (int)value;
    return true;
}

static bool json_get_bool(const char *obj, const char *key, bool *out)
{
    const char *p = json_find_key(obj, key);
    if (p == NULL) return false;
    p = strchr(p, ':');
    if (p == NULL) return false;
    ++p;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
    if (strncmp(p, "true", 4) == 0) { *out = true; return true; }
    if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
    return false;
}

#define MAX_CHUNKS 8
typedef struct { char hex[MAX_CHUNKS][512]; int count; } chunks_hex_t;

static bool json_get_chunks(const char *obj, chunks_hex_t *out)
{
    out->count = 0;
    const char *p = json_find_key(obj, "chunks_hex");
    if (p == NULL) return false;
    p = strchr(p, '[');
    if (p == NULL) return false;
    ++p;
    for (;;) {
        while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n' || *p == ',') ++p;
        if (*p == ']') return out->count > 0;
        if (*p != '"') return false;
        ++p;
        size_t n = 0;
        while (*p != '\0' && *p != '"') {
            if (out->count >= MAX_CHUNKS || n + 1 >= sizeof(out->hex[0])) return false;
            out->hex[out->count][n++] = *p++;
        }
        if (*p != '"') return false;
        out->hex[out->count][n] = '\0';
        ++out->count;
        ++p;
    }
}

typedef struct {
    char name[80];
    char direction[24];
    char frame_hex[512];
    char payload_hex[512];
    chunks_hex_t chunks;
    int command;
    int seq;
    int result_code;
    bool frame_valid;
} vector_case_t;

static int for_each_case(const char *path, void (*fn)(const vector_case_t *))
{
    FILE *fp = fopen(path, "rb");
    if (fp == NULL) {
        fprintf(stderr, "[FAIL] cannot open vectors: %s\n", path);
        return -1;
    }
    if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); return -1; }
    long size = ftell(fp);
    if (size <= 0) { fclose(fp); return -1; }
    rewind(fp);
    char *text = malloc((size_t)size + 1);
    if (text == NULL) { fclose(fp); return -1; }
    size_t read = fread(text, 1, (size_t)size, fp);
    fclose(fp);
    text[read] = '\0';

    const char *cases = strstr(text, "\"cases\"");
    if (cases == NULL) { fprintf(stderr, "[FAIL] vectors missing \"cases\"\n"); free(text); return -1; }
    const char *p = strchr(cases, '[');
    if (p == NULL) { free(text); return -1; }

    static char object[8192];
    int count = 0;
    for (;;) {
        while (*p != '\0' && *p != '{' && *p != ']') ++p;
        if (*p == '\0' || *p == ']') break;
        const char *end = strchr(p, '}');
        if (end == NULL) break;
        size_t len = (size_t)(end - p) + 1;
        if (len >= sizeof(object)) { fprintf(stderr, "[FAIL] vector case too large\n"); free(text); return -1; }
        memcpy(object, p, len);
        object[len] = '\0';

        vector_case_t c;
        memset(&c, 0, sizeof(c));
        c.command = -1;
        c.seq = -1;
        c.result_code = -1;
        if (!json_get_string(object, "name", c.name, sizeof(c.name)) ||
            !json_get_string(object, "direction", c.direction, sizeof(c.direction)) ||
            !json_get_string(object, "frame_hex", c.frame_hex, sizeof(c.frame_hex)) ||
            !json_get_bool(object, "frame_valid", &c.frame_valid)) {
            fprintf(stderr, "[FAIL] malformed vector case near: %.60s\n", object);
            free(text);
            return -1;
        }
        json_get_string(object, "payload_hex", c.payload_hex, sizeof(c.payload_hex));
        json_get_int(object, "command", &c.command);
        json_get_int(object, "seq", &c.seq);
        json_get_int(object, "result_code", &c.result_code);
        if (!json_get_chunks(object, &c.chunks)) {
            fprintf(stderr, "[FAIL] vector %s missing chunks_hex\n", c.name);
            free(text);
            return -1;
        }

        fn(&c);
        ++count;
        p = end + 1;
    }
    free(text);
    return count;
}

/* ---------------- 用例分发 ---------------- */

static bool is_envelope_failure(const char *name)
{
    return strcmp(name, "bad_magic") == 0 || strcmp(name, "bad_version") == 0 ||
           strcmp(name, "bad_length") == 0 || strcmp(name, "bad_checksum") == 0;
}

static void run_app_case(const vector_case_t *c)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = decode_hex(c->frame_hex, &frame, &result_code);

    if (is_envelope_failure(c->name)) {
        CHECK(status == LUMEN_DECODE_ERROR);
        CHECK(result_code == (uint8_t)c->result_code);
        return;
    }

    /* 其余用例（含 frame_valid=false 的命令层拒收）信封必须合法。 */
    CHECK(status == LUMEN_DECODE_OK);
    CHECK(result_code == LUMEN_RESULT_OK);
    if (c->command >= 0) CHECK(frame.command == (uint8_t)c->command);
    if (c->seq >= 0) CHECK(frame.seq == (uint8_t)c->seq);

    uint8_t expected_payload[LUMEN_MAX_PAYLOAD];
    size_t expected_len = hex_to_bytes(c->payload_hex, expected_payload, sizeof(expected_payload));
    CHECK(expected_len != (size_t)-1);
    CHECK(frame.payload_len == (uint8_t)expected_len);
    if (expected_len > 0) CHECK(memcmp(frame.payload, expected_payload, expected_len) == 0);

    /* 命令层 reducer：SetPower / SetBrightness / QueryState 三条真实路径。 */
    lumen_state_t state;
    lumen_state_defaults(&state, 30);
    lumen_command_outcome_t outcome;
    lumen_command_dispatch(&frame, &state, NULL, LUMEN_MAX_BRIGHTNESS, &outcome);

    if (c->frame_valid) {
        CHECK(outcome.result_code == (uint8_t)c->result_code);

        if (frame.command == LUMEN_CMD_SET_POWER) {
            CHECK(outcome.next.power == frame.payload[0]);
            CHECK(outcome.state_changed == (state.power != frame.payload[0]));
        } else if (frame.command == LUMEN_CMD_SET_BRIGHTNESS) {
            CHECK(outcome.next.brightness == frame.payload[0]);
            CHECK(outcome.next.power == state.power);
        } else if (frame.command == LUMEN_CMD_QUERY_STATE) {
            CHECK(outcome.state_report);
            CHECK(!outcome.state_changed);
        }

        /* frame_valid=true 的语义是「命令成功」，结果码必须是 OK。 */
        CHECK(outcome.result_code == LUMEN_RESULT_OK);
    } else {
        /* frame_valid=false：命令层拒收，结果码非 OK。 */
        CHECK(outcome.result_code == (uint8_t)c->result_code);
        CHECK(!outcome.state_changed);
    }
}

static void run_device_case(const vector_case_t *c)
{
    lumen_frame_t frame;
    uint8_t result_code = 0xFF;
    lumen_decode_status_t status = decode_hex(c->frame_hex, &frame, &result_code);

    CHECK(status == LUMEN_DECODE_OK);
    CHECK(result_code == LUMEN_RESULT_OK);
    if (c->command >= 0) CHECK(frame.command == (uint8_t)c->command);
    if (c->seq >= 0) CHECK(frame.seq == (uint8_t)c->seq);

    uint8_t expected_payload[LUMEN_MAX_PAYLOAD];
    size_t expected_len = hex_to_bytes(c->payload_hex, expected_payload, sizeof(expected_payload));
    CHECK(expected_len != (size_t)-1);
    CHECK(frame.payload_len == (uint8_t)expected_len);
    if (expected_len > 0) CHECK(memcmp(frame.payload, expected_payload, expected_len) == 0);

    /* 设备→小程序帧必须能用对应的编码器逐字节复现。 */
    uint8_t out[LUMEN_MAX_FRAME];
    size_t len = 0;
    switch (frame.command) {
    case LUMEN_CMD_ACK:
        CHECK(frame.payload_len == 2);
        len = lumen_protocol_encode_ack(frame.seq, frame.payload[0], frame.payload[1], out, sizeof(out));
        break;
    default:
        len = lumen_protocol_encode(frame.command, frame.seq, frame.payload, frame.payload_len, out, sizeof(out));
        break;
    }
    CHECK(len == expected_len + LUMEN_FRAME_OVERHEAD);
    CHECK_BYTES(out, c->frame_hex, len);
}

static void check_chunks(const vector_case_t *c)
{
    CHECK(c->chunks.count > 0);

    lumen_reasm_t reasm;
    lumen_reasm_init(&reasm);

    uint8_t assembled[LUMEN_MAX_FRAME];
    size_t assembled_len = 0;
    uint32_t now = 1000;

    for (int i = 0; i < c->chunks.count; ++i) {
        uint8_t raw[512];
        size_t raw_len = hex_to_bytes(c->chunks.hex[i], raw, sizeof(raw));
        CHECK(raw_len != (size_t)-1);
        CHECK(raw_len >= 2);

        uint8_t ctrl = raw[0];
        bool first = (ctrl & LUMEN_CHUNK_FIRST) != 0;
        bool last = (ctrl & LUMEN_CHUNK_LAST) != 0;
        CHECK(first == (i == 0));
        CHECK(last == (i == c->chunks.count - 1));
        CHECK((ctrl & LUMEN_CHUNK_INDEX_MASK) == (uint8_t)i);

        lumen_reasm_status_t st = lumen_reasm_feed(&reasm, ctrl, &raw[1], raw_len - 1, now);
        now += 10;
        if (i + 1 < c->chunks.count) {
            CHECK(st == LUMEN_REASM_PENDING);
        } else {
            CHECK(st == LUMEN_REASM_COMPLETE);
            assembled_len = reasm.len;
            memcpy(assembled, reasm.data, assembled_len);
        }
    }

    uint8_t expected[LUMEN_MAX_FRAME];
    size_t expected_len = hex_to_bytes(c->frame_hex, expected, sizeof(expected));
    CHECK(expected_len != (size_t)-1);
    CHECK(assembled_len == expected_len);
    CHECK(memcmp(assembled, expected, expected_len) == 0);

    if (c->chunks.count == 1) {
        uint8_t only[512];
        size_t only_len = hex_to_bytes(c->chunks.hex[0], only, sizeof(only));
        CHECK(only_len != (size_t)-1);
        CHECK(only[0] == LUMEN_CHUNK_SINGLE);
    }
}

static void dispatch_case(const vector_case_t *c)
{
    if (strcmp(c->direction, "app_to_device") == 0) {
        run_app_case(c);
    } else if (strcmp(c->direction, "device_to_app") == 0) {
        run_device_case(c);
    } else {
        fprintf(stderr, "[FAIL] unknown direction: %s\n", c->direction);
        ++g_failures;
    }
    check_chunks(c);
}

/* ---------------- 独立断言 ---------------- */

static void test_protocol_version(void)
{
    /* bt-light 的协议版本 = 5（承袭 lumen v5 契约，docs/protocol.md §5）。 */
    CHECK(LUMEN_VERSION == 0x05);
}

static void test_crc16_kat(void)
{
    const char *kat = "123456789";
    CHECK(lumen_protocol_crc16((const uint8_t *)kat, strlen(kat)) == 0x29B1);
}

static void test_checksum_frame(void)
{
    const uint8_t body[] = {0xA6, 0x05, 0x01, 0x01, 0x01, 0x00, 0x01};
    CHECK(lumen_protocol_crc16(body, sizeof(body)) == 0x2D11);
}

/* ---------------- main ---------------- */

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "[FAIL] usage: %s <vectors.json>\n", argv[0]);
        return 2;
    }
    const char *vectors_path = argv[1];

    FILE *fp = fopen(vectors_path, "rb");
    if (fp == NULL) {
        fprintf(stderr, "[FAIL] cannot open vectors: %s\n", vectors_path);
        return 2;
    }
    fclose(fp);

    int before_version = g_checks;
    test_protocol_version();
    report_test_count("test_protocol_version", before_version);

    int before_crc = g_checks;
    test_crc16_kat();
    report_test_count("test_crc16_kat", before_crc);

    int before_frame = g_checks;
    test_checksum_frame();
    report_test_count("test_checksum_frame", before_frame);

    int case_count = for_each_case(vectors_path, dispatch_case);
    if (case_count < 0) {
        fprintf(stderr, "[FAIL] vector loading failed\n");
        return 2;
    }

    if (g_failures != 0) {
        fprintf(stderr, "\n%d/%d checks failed\n", g_failures, g_checks);
        return 1;
    }
    printf("all %d checks passed\n", g_checks);
    printf("vectors: %d cases\n", case_count);
    return 0;
}