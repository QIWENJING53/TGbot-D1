/**
 * Telegram 双向机器人 Cloudflare Worker
 * 实现了：人机验证、私聊到话题模式的转发、管理员回复中继、话题名动态更新、已编辑消息处理、用户屏蔽功能、关键词自动回复
 * [修改] 存储已从 Cloudflare KV 切换到 D1 (SQLite) 以获取更高的写入容量。
 * [新增] 完整的管理员配置菜单，包括：验证配置、自动回复、关键词屏蔽和按类型过滤。
 * [修复] 修复了管理员配置输入后，用户状态未被正确标记为“已验证”，导致下一个消息流程出错的问题。
 * [新增] 在按类型过滤中增加了：所有转发消息、音频/语音、贴纸/GIF 的过滤开关。
 * [重构] 彻底重构了自动回复和关键词屏蔽的管理界面，引入了列表、新增、删除功能。
 * * 部署要求: 
 * 1. D1 数据库绑定，名称必须为 'TG_BOT_DB'。
 * 2. 环境变量 ADMIN_IDS, BOT_TOKEN, ADMIN_GROUP_ID, 等不变。
 */


// --- 辅助函数 (D1 数据库抽象层) ---

/**
 * [D1 Abstraction] 获取全局配置 (config table)
 */
async function dbConfigGet(key, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
    return row ? row.value : null;
}

/**
 * [D1 Abstraction] 设置/更新全局配置 (config table)
 */
async function dbConfigPut(key, value, env) {
    // INSERT OR REPLACE 确保如果键已存在则更新，否则插入
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
}

/**
 * [D1 Abstraction] 确保用户在 users 表中存在，并返回其数据。
 * 如果用户不存在，则创建默认记录。
 */
async function dbUserGetOrCreate(userId, env) {
    let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();

    if (!user) {
        // 插入默认记录
        await env.TG_BOT_DB.prepare(
            "INSERT INTO users (user_id, user_state, is_blocked, block_count) VALUES (?, 'new', 0, 0)"
        ).bind(userId).run();
        // 重新查询以获取完整的默认记录
        user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    }
    
    // 将 is_blocked 转换为布尔值，并解析 JSON 字段
    if (user) {
        user.is_blocked = user.is_blocked === 1;
        user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
    }
    return user;
}

/**
 * [D1 Abstraction] 更新 users 表中的一个或多个字段
 * data 应该是一个包含要更新字段的对象 { topic_id: '...', user_state: '...' }
 */
async function dbUserUpdate(userId, data, env) {
    // 确保 user_info_json 是 JSON 字符串
    if (data.user_info) {
        data.user_info_json = JSON.stringify(data.user_info);
        delete data.user_info; // 移除原始对象以避免与 SQL 冲突
    }
    
    // 构造 SQL 语句
    const fields = Object.keys(data).map(key => `${key} = ?`).join(', ');
    const values = Object.values(data);
    
    await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
}

/**
 * [D1 Abstraction] 根据 topic_id 查找 user_id
 */
async function dbTopicUserGet(topicId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
    return row ? row.user_id : null;
}

/**
 * [D1 Abstraction] 存入消息数据 (messages table)
 * 用于已编辑消息跟踪。
 */
async function dbMessageDataPut(userId, messageId, data, env) {
    // data 包含 { text, date }
    await env.TG_BOT_DB.prepare(
        "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)"
    ).bind(userId, messageId, data.text, data.date).run();
}

/**
 * [D1 Abstraction] 获取消息数据 (messages table)
 * 用于已编辑消息跟踪。
 */
async function dbMessageDataGet(userId, messageId, env) {
    const row = await env.TG_BOT_DB.prepare(
        "SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?"
    ).bind(userId, messageId).first();
    return row || null;
}


/**
 * [D1 Abstraction] 清除管理员编辑状态
 */
async function dbAdminStateDelete(userId, env) {
    await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run();
}

/**
 * [D1 Abstraction] 获取管理员编辑状态
 */
async function dbAdminStateGet(userId, env) {
    const stateJson = await dbConfigGet(`admin_state:${userId}`, env);
    return stateJson || null;
}

/**
 * [D1 Abstraction] 设置管理员编辑状态
 */
async function dbAdminStatePut(userId, stateJson, env) {
    await dbConfigPut(`admin_state:${userId}`, stateJson, env);
}


// --- 辅助函数 ---

function escapeHtml(text) {
  if (!text) return '';
  return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

function getUserInfo(user, initialTimestamp = null) {
    const userId = user.id.toString();
    const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
    const rawUsername = user.username ? `@${user.username}` : "无";
    
    const safeName = escapeHtml(rawName);
    const safeUsername = escapeHtml(rawUsername);
    const safeUserId = escapeHtml(userId);

    const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);

    const timestamp = initialTimestamp ? new Date(initialTimestamp * 1000).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
    
    const infoCard = `
<b>👤 用户资料卡</b>
---
• 昵称/名称: <code>${safeName}</code>
• 用户名: <code>${safeUsername}</code>
• ID: <code>${safeUserId}</code>
• 首次连接时间: <code>${timestamp}</code>
    `.trim();

    return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}

/**
 * 生成用户资料卡下方的操作按钮（屏蔽/解禁/置顶）
 */
function getInfoCardButtons(userId, isBlocked) {
    const blockAction = isBlocked ? "unblock" : "block";
    const blockText = isBlocked ? "✅ 解除屏蔽 (Unblock)" : "🚫 屏蔽此人 (Block)";
    return {
        inline_keyboard: [
            [{ // Row 1: Block/Unblock Button
                text: blockText,
                callback_data: `${blockAction}:${userId}`
            }],
            [{ // Row 2: Pin Button
                text: "📌 置顶此消息 (Pin Card)",
                callback_data: `pin_card:${userId}` 
            }]
        ]
    };
}


/**
 * 优先从 D1 获取配置，其次从环境变量获取，最后使用默认值。
 */
async function getConfig(key, env, defaultValue) {
    const configValue = await dbConfigGet(key, env);
    
    // 如果 D1 中有配置，直接返回 D1 的值
    if (configValue !== null) {
        return configValue;
    }
    
    // 如果 D1 中没有，检查环境变量（作为后备或兼容性）
    const envKey = key.toUpperCase()
                      .replace('WELCOME_MSG', 'WELCOME_MESSAGE')
                      .replace('VERIF_Q', 'VERIFICATION_QUESTION')
                      .replace('VERIF_A', 'VERIFICATION_ANSWER')
                      .replace(/_FORWARDING/g, '_FORWARDING');
    
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== null) {
        return envValue;
    }
    
    // 都没有，返回代码默认值
    return defaultValue;
}

function isAdminUser(userId, env) {
    if (!env.ADMIN_IDS) return false;
    const adminIds = env.ADMIN_IDS.split(',').map(id => id.trim());
    return adminIds.includes(userId.toString());
}


// --- 规则管理重构区域 ---

/**
 * [重构] 获取自动回复规则列表（将 JSON 字符串解析为数组）
 * 结构：[{ keywords: "a|b", response: "reply", id: timestamp }, ...]
 */
async function getAutoReplyRules(env) {
    const jsonString = await getConfig('keyword_responses', env, '[]');
    try {
        const rules = JSON.parse(jsonString);
        return Array.isArray(rules) ? rules : [];
    } catch (e) {
        // 兼容旧版，如果无法解析为 JSON，尝试解析为旧版字符串格式
        const oldRules = parseOldKeywordResponses(jsonString);
        // 如果旧版也成功解析，则转换为新结构并保存，否则返回空数组
        if (oldRules.length > 0) {
            console.warn("Found old KEYWORD_RESPONSES format. Attempting conversion.");
            const newRules = oldRules.map(rule => ({
                keywords: rule.keywords.source, 
                response: rule.response,
                id: Date.now() + Math.random(), // 赋予临时ID
            }));
            await dbConfigPut('keyword_responses', JSON.stringify(newRules), env);
            return newRules;
        }
        return [];
    }
}

/**
 * [重构] 获取屏蔽关键词列表（将 JSON 字符串解析为数组）
 * 结构：["keyword1|keyword2", "keyword3", ...]
 */
async function getBlockKeywords(env) {
    const jsonString = await getConfig('block_keywords', env, '[]');
    try {
        const keywords = JSON.parse(jsonString);
        return Array.isArray(keywords) ? keywords : [];
    } catch (e) {
        // 兼容旧版，如果无法解析为 JSON，尝试解析为旧版字符串格式
        const oldKeywords = parseOldBlockKeywords(jsonString).map(r => r.source);
        if (oldKeywords.length > 0) {
            console.warn("Found old BLOCK_KEYWORDS format. Attempting conversion.");
            await dbConfigPut('block_keywords', JSON.stringify(oldKeywords), env);
            return oldKeywords;
        }
        return [];
    }
}

/**
 * [重构] 用于处理旧版格式的解析（临时兼容）
 */
function parseOldKeywordResponses(envValue) {
    if (!envValue) return [];
    const rules = [];
    const lines = envValue.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

        const parts = trimmedLine.split('===');
        if (parts.length === 2) {
            const keywords = parts[0].trim();
            const response = parts[1].trim();

            if (keywords && response) {
                try {
                    const regex = new RegExp(keywords, 'gi'); 
                    rules.push({ keywords: regex, response }); // 存储 regex 对象
                } catch (e) {
                    console.error("Invalid RegExp in KEYWORD_RESPONSES (Old Format):", keywords, e);
                }
            }
        }
    }
    return rules;
}

/**
 * [重构] 用于处理旧版关键词屏蔽的解析（临时兼容）
 */
function parseOldBlockKeywords(envValue) {
    if (!envValue) return [];
    const rules = [];
    const lines = envValue.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('//')) continue; 

        try {
            const regex = new RegExp(trimmedLine, 'gi');
            rules.push(regex);
        } catch (e) {
            console.error("Invalid RegExp in BLOCK_KEYWORDS (Old Format):", trimmedLine, e);
        }
    }
    return rules;
}


// --- API 客户端 ---

async function telegramApi(token, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${token}/${methodName}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
    });

    let data;
    try {
        data = await response.json();
    } catch (e) {
        console.error(`Telegram API ${methodName} 返回非 JSON 响应`, e);
        throw new Error(`Telegram API ${methodName} returned non-JSON response`);
    }

    if (!data.ok) {
        console.error(`Telegram API error (${methodName}): ${data.description}. Params: ${JSON.stringify(params)}. Full response:`, data);
        throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
    }

    return data.result;
}


// --- 核心更新处理函数 ---

export default {
  async fetch(request, env, ctx) {
      if (request.method === "POST") {
          try {
              const update = await request.json();
              if (!env.TG_BOT_DB) {
                  // 如果 D1 绑定缺失，Worker 应该在部署时报错，但为了安全，仍然检查。
                  throw new Error("TG_BOT_DB D1 数据库绑定缺失。");
              }
              // 使用 ctx.waitUntil 确保异步处理不会被 Worker 提前终止
              ctx.waitUntil(handleUpdate(update, env)); 
          } catch (e) {
              console.error("处理更新时出错:", e);
          }
      }
      return new Response("OK");
  },
};

async function handleUpdate(update, env) {
    if (update.message) {
        if (update.message.chat.type === "private") {
            await handlePrivateMessage(update.message, env);
        }
        else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) {
            await handleAdminReply(update.message, env);
        }
    } else if (update.edited_message) {
        if (update.edited_message.chat.type === "private") {
            await handleRelayEditedMessage(update.edited_message, env);
        }
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
    } 
    // 移除了 update.message_deleted 的处理
}

async function handlePrivateMessage(message, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";
    const userId = chatId;

    const isAdmin = isAdminUser(userId, env);
    
    // 1. 检查 /start 或 /help 命令
    if (text === "/start" || text === "/help") {
        if (isAdmin) {
            await handleAdminConfigStart(chatId, env);
        } else {
            await handleStart(chatId, env);
        }
        return;
    }
    
    // 从 D1 获取用户数据
    const user = await dbUserGetOrCreate(userId, env);
    const isBlocked = user.is_blocked;

    if (isBlocked) {
        return; 
    }
    
    // 管理员在配置编辑状态中发送的文本输入
    if (isAdmin) {
        const adminStateJson = await dbAdminStateGet(userId, env);
        if (adminStateJson) {
            await handleAdminConfigInput(userId, text, adminStateJson, env);
            return;
        }
        
        // --- 核心修复: 确保管理员用户跳过验证 ---
        if (user.user_state !== "verified") {
            // 更新本地 user 对象和 D1 数据库
            user.user_state = "verified"; 
            await dbUserUpdate(userId, { user_state: "verified" }, env); 
        }
        // --- 修复结束 ---
    }

    // 2. 检查用户的验证状态
    const userState = user.user_state;

    if (userState === "pending_verification") {
        await handleVerification(chatId, text, env);
    } else if (userState === "verified") {
        
        // --- [关键词屏蔽检查] ---
        const blockKeywords = await getBlockKeywords(env); // 获取 JSON 数组
        const blockThreshold = parseInt(await getConfig('block_threshold', env, "5"), 10) || 5; 
        
        if (blockKeywords.length > 0 && text) { 
            let currentCount = user.block_count;
            
            for (const keyword of blockKeywords) {
                try {
                    // 使用新结构中的字符串构建 RegExp
                    const regex = new RegExp(keyword, 'gi'); 
                    if (regex.test(text)) {
                        currentCount += 1;
                        
                        // 更新 D1 中的屏蔽计数
                        await dbUserUpdate(userId, { block_count: currentCount }, env);
                        
                        const blockNotification = `⚠️ 您的消息触发了屏蔽关键词过滤器 (${currentCount}/${blockThreshold}次)，此消息已被丢弃，不会转发给对方。`;
                        
                        if (currentCount >= blockThreshold) {
                            // 达到阈值，自动屏蔽用户 (is_blocked = 1)
                            await dbUserUpdate(userId, { is_blocked: 1 }, env);
                            const autoBlockMessage = `❌ 您已多次触发屏蔽关键词，根据设置，您已被自动屏蔽。机器人将不再接收您的任何消息。`;
                            
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: autoBlockMessage });
                            return;
                        }
                        
                        await telegramApi(env.BOT_TOKEN, "sendMessage", {
                            chat_id: chatId,
                            text: blockNotification,
                        });

                        return; 
                    }
                } catch(e) {
                    console.error("Invalid keyword block regex:", keyword, e);
                    // 忽略无效的正则，继续检查下一个
                }
            }
        }

        // --- [转发内容过滤检查] ---
        const filters = {
            // 图片/视频/文件 (原 enable_image_forwarding)
            media: (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true',
            // 链接
            link: (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true',
            // 纯文本
            text: (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true',
            // 频道转发 (细分)
            channel_forward: (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true', 
            
            // 新增过滤器
            // 任何转发消息 (用户/群组/频道)
            any_forward: (await getConfig('enable_forward_forwarding', env, 'true')).toLowerCase() === 'true', 
            // 音频文件和语音消息
            audio_voice: (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true', 
            // 贴纸，emojy，gif (sticker, animation)
            sticker_gif: (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true', 
        };

        let isForwardable = true;
        let filterReason = '';

        const hasLinks = (msg) => {
            const entities = msg.entities || msg.caption_entities || [];
            return entities.some(entity => entity.type === 'url' || entity.type === 'text_link');
        };

        // 1. 任何转发消息（用户、群组、频道）
        if (message.forward_from || message.forward_from_chat) {
             // 检查总开关
             if (!filters.any_forward) {
                isForwardable = false;
                filterReason = '转发消息 (来自用户/群组/频道)';
            } 
            // 如果总开关允许，但它是频道转发，再检查频道细分开关
            else if (message.forward_from_chat && message.forward_from_chat.type === 'channel' && !filters.channel_forward) {
                isForwardable = false;
                filterReason = '频道转发消息';
            }
        } 
        // 2. 音频文件和语音消息
        else if (message.audio || message.voice) {
            if (!filters.audio_voice) {
                isForwardable = false;
                filterReason = '音频或语音消息';
            }
        }
        // 3. 贴纸，emojy，gif (sticker, animation)
        else if (message.sticker || message.animation) {
             if (!filters.sticker_gif) {
                isForwardable = false;
                filterReason = '贴纸或GIF';
            }
        }
        // 4. 其他媒体（Photo, Video, Document） - 使用 'media' (原 enable_image_forwarding)
        else if (message.photo || message.video || message.document) {
            if (!filters.media) {
                isForwardable = false;
                filterReason = '媒体内容（图片/视频/文件）';
            }
        } 
        
        // 5. 链接检查 (保留原逻辑，作用于任何包含链接的消息)
        if (isForwardable && hasLinks(message)) {
            if (!filters.link) {
                isForwardable = false;
                filterReason = filterReason ? `${filterReason} (并包含链接)` : '包含链接的内容';
            }
        }

        // 6. 纯文本检查 (保留原逻辑)
        // 检查是否是纯文本（排除所有媒体和转发类型）
        const isPureText = message.text && 
                           !message.photo && !message.video && !message.document && 
                           !message.sticker && !message.audio && !message.voice && 
                           !message.forward_from_chat && !message.forward_from && !message.animation; 
        
        if (isForwardable && isPureText) {
            if (!filters.text) {
                isForwardable = false;
                filterReason = '纯文本内容';
            }
        }

        if (!isForwardable) {
            const filterNotification = `此消息已被过滤：${filterReason}。根据设置，此类内容不会转发给对方。`;
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: filterNotification,
            });
            return; 
        }
        
        // --- [Keyword Auto-Reply Check] ---
        const autoResponseRules = await getAutoReplyRules(env); // 获取 JSON 数组
        if (autoResponseRules.length > 0 && text) { 
            
            for (const rule of autoResponseRules) {
                try {
                    // 使用新结构中的 keywords 字符串构建 RegExp
                    const regex = new RegExp(rule.keywords, 'gi'); 
                    if (regex.test(text)) {
                        const autoReplyPrefix = "此消息为自动回复\n\n";
                        await telegramApi(env.BOT_TOKEN, "sendMessage", {
                            chat_id: chatId,
                            text: autoReplyPrefix + rule.response,
                        });
                        return; 
                    }
                } catch(e) {
                    console.error("Invalid auto-reply regex:", rule.keywords, e);
                    // 忽略无效的正则，继续检查下一个
                }
            }
        }
        
        await handleRelayToTopic(message, user, env); // 传递 user 对象
        
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "请使用 /start 命令开始。",
        });
    }
}

// --- 验证逻辑 (使用 D1) ---

async function handleStart(chatId, env) {
    const welcomeMessage = await getConfig('welcome_msg', env, "欢迎！在使用之前，请先完成人机验证。");
    
    const defaultVerificationQuestion = 
        "问题：1+1=?\n\n" +
        "提示：\n" +
        "1. 正确答案不是“2”。\n" +
        "2. 答案在机器人简介内，请看简介的答案进行回答。";
        
    const verificationQuestion = await getConfig('verif_q', env, defaultVerificationQuestion);

    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
    
    // 更新 D1 中的用户状态
    await dbUserUpdate(chatId, { user_state: "pending_verification" }, env);
}

async function handleVerification(chatId, answer, env) {
    const expectedAnswer = await getConfig('verif_a', env, "3"); 

    if (answer === expectedAnswer) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "✅ 验证通过！您现在可以发送消息了。",
        });
        // 更新 D1 中的用户状态
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: chatId,
            text: "❌ 验证失败！\n请查看机器人简介查找答案，然后重新回答。",
        });
    }
}

// --- 管理员配置主菜单逻辑 (使用 D1) ---

async function handleAdminConfigStart(chatId, env) {
    const menuText = `
⚙️ <b>机器人主配置菜单</b>

请选择要管理的配置类别：
    `.trim();

    const menuKeyboard = {
        inline_keyboard: [
            // 第一行：配置
            [{ text: "📝 基础配置 (验证问答)", callback_data: "config:menu:base" }],
            // 第二行：功能
            [{ text: "🤖 自动回复管理", callback_data: "config:menu:autoreply" }],
            [{ text: "🚫 关键词屏蔽管理", callback_data: "config:menu:keyword" }],
            // 第三行：过滤
            [{ text: "🔗 按类型过滤管理", callback_data: "config:menu:filter" }],
            // 第四行：刷新
            [{ text: "🔄 刷新主菜单", callback_data: "config:menu" }],
        ]
    };

    // 清除任何未完成的编辑状态
    await dbAdminStateDelete(chatId, env);

    await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    });
}

/**
 * [已修复] 基础配置子菜单 - 兼容编辑和发送新消息
 */
async function handleAdminBaseConfigMenu(chatId, messageId, env) {
    const welcomeMsg = await getConfig('welcome_msg', env, "欢迎！...");
    const verifQ = await getConfig('verif_q', env, "问题：1+1=?...");
    const verifA = await getConfig('verif_a', env, "3");

    const menuText = `
⚙️ <b>基础配置 (人机验证)</b>

<b>当前设置:</b>
• 欢迎消息: ${escapeHtml(welcomeMsg).substring(0, 30)}...
• 验证问题: ${escapeHtml(verifQ).substring(0, 30)}...
• 验证答案: <code>${escapeHtml(verifA)}</code>

请选择要修改的配置项:
    `.trim();

    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "📝 编辑欢迎消息", callback_data: "config:edit:welcome_msg" }],
            [{ text: "❓ 编辑验证问题", callback_data: "config:edit:verif_q" }],
            [{ text: "🔑 编辑验证答案", callback_data: "config:edit:verif_a" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };

    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

/**
 * [重构] 自动回复子菜单 - 兼容编辑和发送新消息
 */
async function handleAdminAutoReplyMenu(chatId, messageId, env) {
    const rules = await getAutoReplyRules(env);
    const ruleCount = rules.length;
    
    const menuText = `
🤖 <b>自动回复管理</b>

当前规则总数：<b>${ruleCount}</b> 条。

请选择操作：
    `.trim();

    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "➕ 新增自动回复规则", callback_data: "config:add:keyword_responses" }],
            [{ text: `🗑️ 管理/删除现有规则 (${ruleCount}条)`, callback_data: "config:list:keyword_responses" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };

    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

/**
 * [重构] 关键词屏蔽子菜单 - 兼容编辑和发送新消息
 */
async function handleAdminKeywordBlockMenu(chatId, messageId, env) {
    const blockKeywords = await getBlockKeywords(env);
    const keywordCount = blockKeywords.length;
    const blockThreshold = await getConfig('block_threshold', env, "5");

    const menuText = `
🚫 <b>关键词屏蔽管理</b>

当前屏蔽关键词总数：<b>${keywordCount}</b> 个。
屏蔽次数阈值：<code>${escapeHtml(blockThreshold)}</code> 次。

请选择操作：
    `.trim();

    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "➕ 新增屏蔽关键词", callback_data: "config:add:block_keywords" }],
            [{ text: `🗑️ 管理/删除现有关键词 (${keywordCount}个)`, callback_data: "config:list:block_keywords" }],
            [{ text: "✏️ 修改屏蔽次数阈值", callback_data: "config:edit:block_threshold" }],
            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };

    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

/**
 * [新增] 规则列表和删除界面
 */
async function handleAdminRuleList(chatId, messageId, env, key) {
    let rules = [];
    let menuText = "";
    let backCallback = "";

    if (key === 'keyword_responses') {
        rules = await getAutoReplyRules(env);
        menuText = `
🤖 <b>自动回复规则列表 (${rules.length}条)</b>

请点击右侧按钮删除对应规则。
规则格式：<code>关键词表达式</code> ➡️ <code>回复内容</code>
---
        `.trim();
        backCallback = "config:menu:autoreply";
    } else if (key === 'block_keywords') {
        rules = await getBlockKeywords(env);
        menuText = `
🚫 <b>屏蔽关键词列表 (${rules.length}个)</b>

请点击右侧按钮删除对应关键词。
关键词格式：<code>关键词表达式</code>
---
        `.trim();
        backCallback = "config:menu:keyword";
    } else {
        return;
    }

    const ruleButtons = [];
    if (rules.length === 0) {
        menuText += "\n\n<i>（列表为空）</i>";
    } else {
        rules.forEach((rule, index) => {
            let label = "";
            let deleteId = "";
            
            if (key === 'keyword_responses') {
                // 自动回复规则：使用 ID 进行删除
                const keywordsSnippet = rule.keywords.substring(0, 15);
                const responseSnippet = rule.response.substring(0, 20);
                label = `${index + 1}. <code>${escapeHtml(keywordsSnippet)}...</code> ➡️ ${escapeHtml(responseSnippet)}...`;
                deleteId = rule.id;
            } else if (key === 'block_keywords') {
                // 屏蔽关键词：直接使用关键词字符串作为 ID (确保唯一)
                const keywordSnippet = rule.substring(0, 25);
                label = `${index + 1}. <code>${escapeHtml(keywordSnippet)}...</code>`;
                deleteId = rule; 
            }
            
            // 添加列表信息到文本
            menuText += `\n${label}`;

            // 添加删除按钮
            ruleButtons.push([
                { 
                    text: `🗑️ 删除 ${index + 1}`, 
                    // config:delete:key:id
                    callback_data: `config:delete:${key}:${deleteId}` 
                }
            ]);
        });
    }

    // 底部返回按钮
    ruleButtons.push([{ text: "⬅️ 返回管理菜单", callback_data: backCallback }]);

    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: ruleButtons },
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
}

/**
 * [新增] 规则删除逻辑
 */
async function handleAdminRuleDelete(chatId, messageId, env, key, id) {
    let rules = [];
    let typeName = "";
    let backCallback = "";

    if (key === 'keyword_responses') {
        rules = await getAutoReplyRules(env);
        typeName = "自动回复规则";
        backCallback = "config:menu:autoreply";
        // 自动回复规则使用 ID 删除
        rules = rules.filter(rule => rule.id.toString() !== id.toString());
    } else if (key === 'block_keywords') {
        rules = await getBlockKeywords(env);
        typeName = "屏蔽关键词";
        backCallback = "config:menu:keyword";
        // 屏蔽关键词直接使用字符串删除
        rules = rules.filter(keyword => keyword !== id);
    } else {
        return;
    }

    // 存储更新后的规则列表
    await dbConfigPut(key, JSON.stringify(rules), env);

    // 刷新列表界面
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: chatId, text: `✅ ${typeName}已删除并更新。`, show_alert: false });
    await handleAdminRuleList(chatId, messageId, env, key);
}


/**
 * [已修复/增强] 按类型过滤子菜单 - 兼容编辑和发送新消息
 */
async function handleAdminTypeBlockMenu(chatId, messageId, env) {
    // 获取当前状态，检查 D1 -> ENV -> 默认值 'true'
    const mediaStatus = (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true'; // 图片/视频/文件
    const linkStatus = (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true';
    const textStatus = (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true';
    
    const channelForwardStatus = (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true'; // 频道转发
    const anyForwardStatus = (await getConfig('enable_forward_forwarding', env, 'true')).toLowerCase() === 'true'; // 任何转发
    const audioVoiceStatus = (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true'; // 音频/语音
    const stickerGifStatus = (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true'; // 贴纸/GIF

    const statusToText = (status) => status ? "✅ 允许" : "❌ 屏蔽";
    // 构造回调数据：config:toggle:key:new_value (e.g., config:toggle:enable_image_forwarding:false)
    const statusToCallback = (key, status) => `config:toggle:${key}:${status ? 'false' : 'true'}`;

    const menuText = `
🔗 <b>按类型过滤管理</b>

点击按钮切换转发状态 (切换后立即生效)。

| 类型 | 状态 |
| :--- | :--- |
| <b>转发消息（用户/群组/频道）</b>| ${statusToText(anyForwardStatus)} |
| 频道转发消息 (细分) | ${statusToText(channelForwardStatus)} |
| <b>音频/语音消息</b> | ${statusToText(audioVoiceStatus)} |
| <b>贴纸/GIF (动画)</b> | ${statusToText(stickerGifStatus)} |
| 图片/视频/文件 | ${statusToText(mediaStatus)} |
| 链接消息 | ${statusToText(linkStatus)} |
| 纯文本消息 | ${statusToText(textStatus)} |
    `.trim();

    const menuKeyboard = {
        inline_keyboard: [
            // 新增的过滤类型
            [{ text: `转发消息 (用户/群组/频道): ${statusToText(anyForwardStatus)}`, callback_data: statusToCallback('enable_forward_forwarding', anyForwardStatus) }],
            [{ text: `音频/语音消息 (Audio/Voice): ${statusToText(audioVoiceStatus)}`, callback_data: statusToCallback('enable_audio_forwarding', audioVoiceStatus) }],
            [{ text: `贴纸/GIF (Sticker/Animation): ${statusToText(stickerGifStatus)}`, callback_data: statusToCallback('enable_sticker_forwarding', stickerGifStatus) }],
            
            // 现有的过滤类型
            [{ text: `图片/视频/文件 (Photo/Video/Doc): ${statusToText(mediaStatus)}`, callback_data: statusToCallback('enable_image_forwarding', mediaStatus) }],
            [{ text: `频道转发消息 (Channel Forward): ${statusToText(channelForwardStatus)}`, callback_data: statusToCallback('enable_channel_forwarding', channelForwardStatus) }],
            [{ text: `链接消息 (URL/TextLink): ${statusToText(linkStatus)}`, callback_data: statusToCallback('enable_link_forwarding', linkStatus) }],
            [{ text: `纯文本消息 (Pure Text): ${statusToText(textStatus)}`, callback_data: statusToCallback('enable_text_forwarding', textStatus) }],

            [{ text: "⬅️ 返回主菜单", callback_data: "config:menu" }],
        ]
    };


    const apiMethod = (messageId && messageId !== 0) ? "editMessageText" : "sendMessage";
    const params = {
        chat_id: chatId,
        text: menuText,
        parse_mode: "HTML",
        reply_markup: menuKeyboard,
    };
    if (apiMethod === "editMessageText") {
        params.message_id = messageId;
    }
    await telegramApi(env.BOT_TOKEN, apiMethod, params);
}


async function handleAdminConfigInput(userId, text, adminStateJson, env) {
    const adminState = JSON.parse(adminStateJson);

    if (text.toLowerCase() === "/cancel") {
        // 删除状态
        await dbAdminStateDelete(userId, env);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "✅ 编辑已取消。", });
        await handleAdminConfigStart(userId, env); 
        return;
    }
    
    if (adminState.action === 'awaiting_input' && adminState.key) {
        
        let successMsg = "";
        let finalValue = text;

        if (adminState.key === 'verif_a' || adminState.key === 'block_threshold') {
            finalValue = text.trim(); 
        }

        // --- 新增规则逻辑 ---
        if (adminState.key === 'block_keywords_add') {
            const blockKeywords = await getBlockKeywords(env);
            const newKeyword = finalValue.trim();
            if (newKeyword && !blockKeywords.includes(newKeyword)) {
                blockKeywords.push(newKeyword);
                await dbConfigPut('block_keywords', JSON.stringify(blockKeywords), env);
                successMsg = `✅ 屏蔽关键词 <code>${escapeHtml(newKeyword)}</code> 已添加。`;
            } else {
                 successMsg = `⚠️ 屏蔽关键词未添加，内容为空或已存在。`;
            }
            // 清除状态
            await dbAdminStateDelete(userId, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
            await handleAdminKeywordBlockMenu(userId, 0, env); 
            return;
        } else if (adminState.key === 'keyword_responses_add') {
            const rules = await getAutoReplyRules(env);
            
            // 格式: 关键词===回复内容
            const parts = finalValue.split('===');
            if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
                const newRule = {
                    keywords: parts[0].trim(),
                    response: parts[1].trim(),
                    id: Date.now(), // 使用时间戳作为唯一ID
                };
                rules.push(newRule);
                await dbConfigPut('keyword_responses', JSON.stringify(rules), env);
                successMsg = `✅ 自动回复规则已添加。关键词: <code>${escapeHtml(newRule.keywords)}</code>`;
            } else {
                 successMsg = `⚠️ 自动回复规则未添加。请确保格式正确：<code>关键词===回复内容</code>`;
            }
            // 清除状态
            await dbAdminStateDelete(userId, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: successMsg, parse_mode: "HTML" });
            await handleAdminAutoReplyMenu(userId, 0, env); 
            return;
        }

        // --- 基础配置修改逻辑 ---
        
        // 存储新的配置到 D1 的 config 表
        await dbConfigPut(adminState.key, finalValue, env);
        
        // 清除管理员状态
        await dbAdminStateDelete(userId, env);
        
        switch (adminState.key) {
            case 'welcome_msg': successMsg = `✅ <b>欢迎消息</b>已更新。`; break;
            case 'verif_q': successMsg = `✅ <b>验证问题</b>已更新。`; break;
            case 'verif_a': successMsg = `✅ <b>验证答案</b>已更新为：<code>${escapeHtml(finalValue)}</code>`; break;
            case 'block_threshold': successMsg = `✅ <b>屏蔽次数阈值</b>已更新为：<code>${escapeHtml(finalValue)}</code>`; break;
            default: successMsg = "✅ 配置已更新。"; break;
        }

        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: userId,
            text: successMsg,
            parse_mode: "HTML",
        });

        // 跳转到对应的子菜单
        let nextMenuAction = 'config:menu';
        if (['welcome_msg', 'verif_q', 'verif_a'].includes(adminState.key)) {
            nextMenuAction = 'config:menu:base';
        } else if (adminState.key === 'keyword_responses') {
            // 注意：keyword_responses 不再支持直接编辑
            nextMenuAction = 'config:menu:autoreply';
        } else if (['block_keywords', 'block_threshold'].includes(adminState.key)) {
            // 注意：block_keywords 不再支持直接编辑
            nextMenuAction = 'config:menu:keyword';
        }
        
        // 关键修复：发送成功消息后，我们发送一个新的菜单消息 (messageId = 0)，实现自动跳转。
        if (nextMenuAction === 'config:menu:base') {
            await handleAdminBaseConfigMenu(userId, 0, env); 
        } else if (nextMenuAction === 'config:menu:autoreply') {
             await handleAdminAutoReplyMenu(userId, 0, env); 
        } else if (nextMenuAction === 'config:menu:keyword') {
             await handleAdminKeywordBlockMenu(userId, 0, env); 
        } else {
             await handleAdminConfigStart(userId, env); // 返回主菜单
        }


    } else {
        // 删除状态
        await dbAdminStateDelete(userId, env);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "⚠️ 状态错误，已重置。请重新使用 /start 访问菜单。", });
    }
}


async function handleRelayToTopic(message, user, env) { // 接收 user 对象
    const { from: userDetails, date } = message;
    const { userId, topicName, infoCard } = getUserInfo(userDetails, date);
    let topicId = user.topic_id;
    const isBlocked = user.is_blocked;

    // Helper: 创建新话题并发送信息卡
    const createTopicForUser = async () => {
        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: topicName,
            });
            const newTopicId = newTopic.message_thread_id.toString();
            const { name, username } = getUserInfo(userDetails, date);
            const newInfo = { name, username, first_message_timestamp: date };

            // 存储 topic_id 和 user_info 到 D1
            await dbUserUpdate(userId, { 
                topic_id: newTopicId,
                user_info: newInfo // dbUserUpdate 会自动处理为 JSON
            }, env);

            // 发送信息卡到新话题，附带操作按钮
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                text: infoCard,
                message_thread_id: newTopicId,
                parse_mode: "HTML",
                reply_markup: getInfoCardButtons(userId, isBlocked), 
            });

            return newTopicId;
        } catch (e) {
            console.error("createTopicForUser 创建话题失败:", e?.message || e);
            throw e;
        }
    };

    // 如果没有 topicId，直接创建
    if (!topicId) {
        try {
            topicId = await createTopicForUser();
        } catch (e) {
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法连接客服（创建话题失败）。请稍后再试。",
            });
            return;
        }
    }

    // 现在尝试把用户的消息复制到 topicId；如果失败（例如话题已被删除/无效），则重建话题后再转发
    const tryCopyToTopic = async (targetTopicId) => {
        try {
            const result = await telegramApi(env.BOT_TOKEN, "copyMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                from_chat_id: userId,
                message_id: message.message_id,
                message_thread_id: targetTopicId,
            });
            return result;
        } catch (e) {
            console.error(`tryCopyToTopic 到话题 ${targetTopicId} 失败:`, e?.message || e);
            throw e;
        }
    };

    try {
        await tryCopyToTopic(topicId);
    } catch (e) {
        // 出错：可能话题被删除或无效，清理 D1 并尝试重建话题一次
        try {
            // 删除旧的 topic_id 映射
            await dbUserUpdate(userId, { topic_id: null }, env);
            
            // 重新创建话题并把消息复制到新话题
            const newTopicId = await createTopicForUser();
            try {
                await tryCopyToTopic(newTopicId);
            } catch (e2) {
                console.error("尝试将消息复制到新话题也失败:", e2?.message || e2);
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "抱歉，消息转发失败（请稍后再试或联系管理员）。",
                });
                return;
            }
        } catch (createErr) {
            console.error("在处理话题失效时，创建新话题失败:", createErr?.message || createErr);
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: "抱歉，无法创建新的客服话题（请稍后再试）。",
            });
            return;
        }
    }

    // 存储文本消息的原始内容到 messages 表 (用于处理已编辑消息)
    if (message.text) {
        const messageData = {
            text: message.text,
            date: message.date
        };
        await dbMessageDataPut(userId, message.message_id.toString(), messageData, env);
    }
}

/**
* 处理用户在私聊中修改消息的逻辑。
*/
async function handleRelayEditedMessage(editedMessage, env) {
    const { from: user } = editedMessage;
    const userId = user.id.toString();
    
    // 获取用户数据
    const userData = await dbUserGetOrCreate(userId, env);
    const topicId = userData.topic_id;

    if (!topicId) {
        return; 
    }

    // 从 D1 的 messages 表获取原始消息数据
    const storedData = await dbMessageDataGet(userId, editedMessage.message_id.toString(), env);
    let originalText = "[原始内容无法获取/非文本内容]";
    let originalDate = "[发送时间无法获取]";
    
    if (storedData) {
        originalText = storedData.text || originalText;
        originalDate = new Date(storedData.date * 1000).toLocaleString('zh-CN');

        // 更新 D1，将新内容存储为该消息的最新“原始”内容
        const updatedData = { 
            text: editedMessage.text || editedMessage.caption || '',
            date: storedData.date 
        };
        await dbMessageDataPut(userId, editedMessage.message_id.toString(), updatedData, env);
    }

    const newContent = editedMessage.text || editedMessage.caption || "[非文本/媒体说明内容]";
    
    const notificationText = `
⚠️ <b>用户消息已修改</b>
---
<b>原始信息:</b> 
<code>${escapeHtml(originalText)}</code>

<b>原消息发送时间:</b> 
<code>${originalDate}</code>

<b>修改后的新内容:</b>
${escapeHtml(newContent)}
    `.trim();
    
    try {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: notificationText,
            message_thread_id: topicId,
            parse_mode: "HTML", 
        });
        
    } catch (e) {
        console.error("处理已编辑消息失败:", e.message);
    }
}

/**
* 辅助函数：当用户昵称或用户名更新时，重命名话题并发送新的信息卡
*/
async function updateTopicAndSendCard(user, topicId, newName, newUsername, newTopicName, initialTimestamp, env) {
    const { userId, infoCard: newInfoCard } = getUserInfo(user, initialTimestamp);
    
    try {
        // 从 D1 获取屏蔽状态
        const userData = await dbUserGetOrCreate(userId, env);
        const isBlocked = userData.is_blocked;
        
        await telegramApi(env.BOT_TOKEN, "editForumTopic", {
            chat_id: env.ADMIN_GROUP_ID,
            message_thread_id: topicId,
            name: newTopicName,
        });

        const updateNotification = `🔔 <b>用户资料已更新</b>\n话题名称已自动更新。`;
        
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: updateNotification,
            message_thread_id: topicId,
            parse_mode: "HTML",
        });

        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: newInfoCard,
            message_thread_id: topicId,
            parse_mode: "HTML",
            reply_markup: getInfoCardButtons(userId, isBlocked), 
        });
        
        // 更新 D1 存储的用户信息
        const updatedInfo = { name: newName, username: newUsername, first_message_timestamp: initialTimestamp };
        await dbUserUpdate(userId, { user_info: updatedInfo }, env);

    } catch (e) {
        console.error(`更新话题或发送信息卡失败 (Topic ID: ${topicId}):`, e.message);
    }
}

/**
 * 处理置顶资料卡消息的操作。
 */
async function handlePinCard(callbackQuery, message, env) {
    const topicId = message.message_thread_id; 
    const adminGroupId = message.chat.id;
    const messageIdToPin = message.message_id; 

    try {
        // 调用 pinChatMessage API
        await telegramApi(env.BOT_TOKEN, "pinChatMessage", {
            chat_id: adminGroupId,
            message_id: messageIdToPin,
            message_thread_id: topicId, // 必须指定话题ID才能在话题内置顶
            disable_notification: true, // 不发出置顶通知
        });

        // 成功反馈
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: `📌 资料卡已在话题中置顶。`,
            show_alert: false 
        });

    } catch (e) {
         console.error("处理置顶操作失败:", e.message);
         // 失败反馈
         await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
            callback_query_id: callbackQuery.id,
            text: `❌ 置顶失败。请确保机器人或有群组的置顶权限。错误信息: ${e.message}`,
            show_alert: true
        });
    }
}


/**
* 处理内联按钮的回调查询。
*/
async function handleCallbackQuery(callbackQuery, env) {
    const { data, message, from: user } = callbackQuery;
    const chatId = message.chat.id.toString();

    // 检查是否是管理员配置回调
    if (data.startsWith('config:')) {
        if (!isAdminUser(user.id, env)) {
            await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "您没有权限执行此操作。", show_alert: true });
            return;
        }
        
        const parts = data.split(':'); 
        const actionType = parts[1]; // menu, edit, toggle, add, list, delete
        const keyOrAction = parts[2]; // base, autoreply, keyword, filter, welcome_msg, enable_image_forwarding...
        const value = parts[3]; // true/false for toggle, ID for delete

        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "处理中...", show_alert: false });

        // --- 菜单导航处理 ---
        if (actionType === 'menu') {
            // 在导航到子菜单时，我们尝试编辑原消息
            if (keyOrAction === 'base') {
                await handleAdminBaseConfigMenu(chatId, message.message_id, env);
            } else if (keyOrAction === 'autoreply') {
                await handleAdminAutoReplyMenu(chatId, message.message_id, env);
            } else if (keyOrAction === 'keyword') {
                await handleAdminKeywordBlockMenu(chatId, message.message_id, env);
            } else if (keyOrAction === 'filter') {
                await handleAdminTypeBlockMenu(chatId, message.message_id, env);
            } else { // config:menu (主菜单)
                 // 如果是返回主菜单，先删除旧消息，然后发送新消息 (handleAdminConfigStart 会发新消息)
                 await telegramApi(env.BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: message.message_id }).catch(e => console.error("删除旧消息失败:", e.message));
                await handleAdminConfigStart(chatId, env);
            }
        // --- 切换开关处理 (用于内容过滤) ---
        } else if (actionType === 'toggle' && keyOrAction && value) {
            await dbConfigPut(keyOrAction, value, env);
            await handleAdminTypeBlockMenu(chatId, message.message_id, env); // 刷新过滤菜单
        // --- 进入编辑模式处理 (用于文本输入: 基础配置/阈值) ---
        } else if (actionType === 'edit' && keyOrAction) {
            
            // 设置管理员状态到 D1
            await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: keyOrAction }), env);
            
            let prompt = "";
            switch (keyOrAction) {
                case 'welcome_msg': prompt = "请发送**新的欢迎消息**："; break;
                case 'verif_q': prompt = "请发送**新的人机验证问题**："; break;
                case 'verif_a': prompt = "请发送**新的验证答案**："; break;
                case 'block_threshold': prompt = "请发送**屏蔽次数阈值** (纯数字)："; break;
                default: return;
            }
            
            const cancelBtn = { inline_keyboard: [[{ text: "❌ 取消编辑", callback_data: "config:menu" }]] };

            await telegramApi(env.BOT_TOKEN, "editMessageText", {
                chat_id: chatId,
                message_id: message.message_id,
                text: `${prompt}\n\n发送 \`/cancel\` 或点击下方按钮取消。`,
                parse_mode: "Markdown",
                reply_markup: cancelBtn,
            });
        // --- 进入新增模式处理 (用于添加规则/关键词) ---
        } else if (actionType === 'add' && keyOrAction) {
            
            // 设置管理员状态到 D1 (使用新的 key 标记添加操作)
            const newKey = keyOrAction + '_add';
            await dbAdminStatePut(chatId, JSON.stringify({ action: 'awaiting_input', key: newKey }), env);
            
            let prompt = "";
            let cancelBack = "";
            if (keyOrAction === 'keyword_responses') {
                 prompt = "请发送**新的自动回复规则**：\n\n**格式：** <code>关键词表达式===回复内容</code>\n\n例如：<code>你好|hello===欢迎您，请问有什么可以帮助您的？</code>";
                 cancelBack = "config:menu:autoreply";
            } else if (keyOrAction === 'block_keywords') {
                 prompt = "请发送**新的屏蔽关键词表达式**：\n\n**格式：** <code>关键词表达式</code>\n\n（支持正则表达式，例如：<code>(\uD83D\uDC49|\uD83D\uDCA3)</code>）";
                 cancelBack = "config:menu:keyword";
            } else {
                return;
            }

            const cancelBtn = { inline_keyboard: [[{ text: "❌ 取消添加", callback_data: cancelBack }]] };

            await telegramApi(env.BOT_TOKEN, "editMessageText", {
                chat_id: chatId,
                message_id: message.message_id,
                text: `${prompt}\n\n发送 \`/cancel\` 或点击下方按钮取消。`,
                parse_mode: "HTML",
                reply_markup: cancelBtn,
            });
        // --- 列表模式处理 (显示列表) ---
        } else if (actionType === 'list' && keyOrAction) {
            await handleAdminRuleList(chatId, message.message_id, env, keyOrAction);
        // --- 删除模式处理 (删除单条记录) ---
        } else if (actionType === 'delete' && keyOrAction && value) {
            // value 是要删除的 ID 或关键词字符串
            await handleAdminRuleDelete(chatId, message.message_id, env, keyOrAction, value);
        }
        return; 
    }

    // 非配置相关的操作（屏蔽/置顶）
    if (message.chat.id.toString() !== env.ADMIN_GROUP_ID) {
        return; 
    }

    const [action, userId] = data.split(':');

    // 处理置顶操作
    if (action === 'pin_card') {
        await handlePinCard(callbackQuery, message, env);
        return;
    }

    // 处理屏蔽/解禁操作
    await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callbackQuery.id,
        text: `执行动作: ${action === 'block' ? '屏蔽' : '解除屏蔽'}...`,
        show_alert: false 
    });

    if (action === 'block') {
        await handleBlockUser(userId, message, env);
    } else if (action === 'unblock') {
        await handleUnblockUser(userId, message, env);
    }
}

/**
* 屏蔽用户。
*/
async function handleBlockUser(userId, message, env) {
    try {
        // 设置 D1 中 is_blocked 为 1
        await dbUserUpdate(userId, { is_blocked: 1 }, env);
        
        // 获取用户信息
        const userData = await dbUserGetOrCreate(userId, env);
        const userName = userData.user_info ? userData.user_info.name : `User ${userId}`;
        
        // 1. 更新按钮状态
        const newMarkup = getInfoCardButtons(userId, true);
        await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: newMarkup,
        });
        
        // 2. 发送确认消息
        const confirmation = `❌ **用户 [${userName}] 已被屏蔽。**\n机器人将不再接收此人消息。`;
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: confirmation,
            message_thread_id: message.message_thread_id,
            parse_mode: "Markdown",
        });
        
    } catch (e) {
        console.error("处理屏蔽操作失败:", e.message);
    }
}

/**
* 解除屏蔽用户。
*/
async function handleUnblockUser(userId, message, env) {
    try {
        // 删除屏蔽状态 (is_blocked = 0) 并清除屏蔽计数 (block_count = 0)
        await dbUserUpdate(userId, { is_blocked: 0, block_count: 0 }, env);
        
        // 获取用户信息
        const userData = await dbUserGetOrCreate(userId, env);
        const userName = userData.user_info ? userData.user_info.name : `User ${userId}`;
        
        // 1. 更新按钮状态
        const newMarkup = getInfoCardButtons(userId, false);
        await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: newMarkup,
        });

        // 2. 发送确认消息
        const confirmation = `✅ **用户 [${userName}] 已解除屏蔽。**\n机器人现在可以正常接收其消息。`;
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: confirmation,
            message_thread_id: message.message_thread_id,
            parse_mode: "Markdown",
        });

    } catch (e) {
        console.error("处理解除屏蔽操作失败:", e.message);
    }
}


/**
 * 将管理员在话题中的回复转发回用户。
 */
async function handleAdminReply(message, env) {
    if (!message.is_topic_message || !message.message_thread_id) return;

    const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
    if (message.chat.id.toString() !== adminGroupIdStr) return;

    if (message.from && message.from.is_bot) return;

    const topicId = message.message_thread_id.toString();
    // 从 D1 根据 topic_id 查找 user_id
    const userId = await dbTopicUserGet(topicId, env);
    if (!userId) return;

    try {
        if (message.text) {
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: userId,
                text: message.text,
            });
            return;
        }

        const fromChatId = message.chat.id;
        const msgId = message.message_id;

        await telegramApi(env.BOT_TOKEN, "copyMessage", {
            chat_id: userId,
            from_chat_id: fromChatId,
            message_id: msgId,
        });

    } catch (e) {
        console.error("handleAdminReply: copy/send failed:", e?.message || e);

        // 失败回退逻辑... (保持不变)
        try {
            if (message.photo && message.photo.length) {
                const fileId = message.photo[message.photo.length - 1].file_id;
                await telegramApi(env.BOT_TOKEN, "sendPhoto", {
                    chat_id: userId,
                    photo: fileId,
                    caption: message.caption || "",
                });
            } else if (message.document) {
                await telegramApi(env.BOT_TOKEN, "sendDocument", {
                    chat_id: userId,
                    document: message.document.file_id,
                    caption: message.caption || "",
                });
            } else if (message.video) {
                await telegramApi(env.BOT_TOKEN, "sendVideo", {
                    chat_id: userId,
                    video: message.video.file_id,
                    caption: message.caption || "",
                });
            } else if (message.audio) {
                await telegramApi(env.BOT_TOKEN, "sendAudio", {
                    chat_id: userId,
                    audio: message.audio.file_id,
                    caption: message.caption || "",
                });
            } else if (message.voice) {
                await telegramApi(env.BOT_TOKEN, "sendVoice", {
                    chat_id: userId,
                    voice: message.voice.file_id,
                    caption: message.caption || "",
                });
            } else if (message.sticker) {
                await telegramApi(env.BOT_TOKEN, "sendSticker", {
                    chat_id: userId,
                    sticker: message.sticker.file_id,
                });
            } else if (message.animation) {
                await telegramApi(env.BOT_TOKEN, "sendAnimation", {
                    chat_id: userId,
                    animation: message.animation.file_id,
                    caption: message.caption || "",
                });
            } else {
                await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: userId,
                    text: "管理员发送了机器人无法直接转发的内容（例如投票或某些特殊媒体）。",
                });
            }
        } catch (e2) {
            console.error("handleAdminReply fallback also failed:", e2?.message || e2);
        }
    }
}