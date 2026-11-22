#pragma once

/*
 * config.h — bt-light 固件的纯头文件配置（引脚表 / 上限 / NVS 键名 / 任务参数）。
 *
 * 纯 C 宏，不依赖 ESP-IDF 头，host 单测（gcc -I main）与固件共用同一份。
 * Kconfig 提供的 CONFIG_* 仅在固件构建时定义；host 构建时走默认值分支。
 *
 * 引脚表的唯一真相：Kconfig 的 LUMEN_STRIP_PINS（默认 "3,10,0,1,4,5,6,7"）。
 */

#include <stdint.h>

/* ---------------- 引脚表（Kconfig 提供，host 走默认） ---------------- */
#ifdef CONFIG_LUMEN_STRIP_PINS
#define LUMEN_STRIP_PINS CONFIG_LUMEN_STRIP_PINS
#else
#define LUMEN_STRIP_PINS "3,10,0,1,4,5,6,7"
#endif

/* ---------------- 上限（与 protocol.h 的契约常量一致，这里集中再暴露） ---------------- */
#ifndef LUMEN_MAX_STRIPS
#define LUMEN_MAX_STRIPS 8
#endif
#ifndef LUMEN_MAX_LEDS
#define LUMEN_MAX_LEDS 100
#endif
#ifndef LUMEN_MAX_BRIGHTNESS
#ifdef CONFIG_LUMEN_MAX_BRIGHTNESS
#define LUMEN_MAX_BRIGHTNESS CONFIG_LUMEN_MAX_BRIGHTNESS
#else
#define LUMEN_MAX_BRIGHTNESS 200
#endif
#endif

/* ---------------- NVS 键名（state_store 唯一真相） ---------------- */
#define LUMEN_NVS_NAMESPACE "lumen"
#define LUMEN_NVS_KEY_STATE "state"
#define LUMEN_NVS_KEY_LAYOUT "layout"
#define LUMEN_NVS_KEY_SCENE0 "scene0"
#define LUMEN_NVS_KEY_SCENE1 "scene1"
#define LUMEN_NVS_KEY_SCENE2 "scene2"

/* ---------------- 任务参数（Kconfig 提供，host 走默认） ---------------- */
#ifdef CONFIG_LUMEN_RENDER_TASK_STACK_SIZE
#define LUMEN_RENDER_TASK_STACK_SIZE CONFIG_LUMEN_RENDER_TASK_STACK_SIZE
#else
#define LUMEN_RENDER_TASK_STACK_SIZE 4096
#endif

#ifdef CONFIG_LUMEN_RENDER_TASK_PRIORITY
#define LUMEN_RENDER_TASK_PRIORITY CONFIG_LUMEN_RENDER_TASK_PRIORITY
#else
#define LUMEN_RENDER_TASK_PRIORITY 4
#endif

#ifdef CONFIG_LUMEN_STORE_TASK_STACK_SIZE
#define LUMEN_STORE_TASK_STACK_SIZE CONFIG_LUMEN_STORE_TASK_STACK_SIZE
#else
#define LUMEN_STORE_TASK_STACK_SIZE 3072
#endif

#ifdef CONFIG_LUMEN_STORE_TASK_PRIORITY
#define LUMEN_STORE_TASK_PRIORITY CONFIG_LUMEN_STORE_TASK_PRIORITY
#else
#define LUMEN_STORE_TASK_PRIORITY 2
#endif

/* LED 默认数量（首次上电）。 */
#ifdef CONFIG_LUMEN_LED_COUNT
#define LUMEN_DEFAULT_LED_COUNT CONFIG_LUMEN_LED_COUNT
#else
#define LUMEN_DEFAULT_LED_COUNT 30
#endif

/* RMT mem_block_symbols（C3 上限 192，48 的整数倍）。 */
#ifdef CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS
#define LUMEN_RMT_MEM_BLOCK_SYMBOLS CONFIG_LUMEN_RMT_MEM_BLOCK_SYMBOLS
#else
#define LUMEN_RMT_MEM_BLOCK_SYMBOLS 48
#endif

/* 帧率（骨架期固定 20fps，与参考实现一致）。 */
#ifndef LUMEN_ANIM_FPS
#define LUMEN_ANIM_FPS 20
#endif