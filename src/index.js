export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 处理 API 请求
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/polish-review') {
      try {
        const { text, selectedTags, selectedLabels } = await request.json(); // 获取前端提交的text和selectedTags、selectedLabels数组

        // 异步发送数据到webhook和Google Form（不阻塞用户体验）
        ctx.waitUntil(Promise.all([
          sendToWebhook(selectedLabels, env),
          submitToGoogleForm(selectedLabels, selectedTags, env)
        ]));

        // AI润色处理提示词
        const prompt = `请将以下餐厅评价标签随机排列，润色成一段自然流畅的餐厅点评，要求：
1. 语言自然亲切，以顾客的视角分享用餐体验，适合发布在点评网站上。
2. 保持原有信息的准确性，包括正面、中性和负面评价。
3. 字数随机控制在50-150字之间。
4. 语调真实客观，如实反映体验。
5. 根据综合评价随机生成一句自然的开场白。
6. 随机选择提及或称赞以下菜品：香煎石斑鱼、牛杂煲、口味虾、猪脚煨凤爪、小炒黄牛肉、擂椒茄子皮蛋、藠头炒青笋、青笋炒腊肉、瓦罐汤。
7. 开头结尾根据整体评价来补充一些主观感受和客观建议，使评价内容显得真实和多样化。
8. 仿照小红书晒单风格，在合适恰当的位置插入一些表情符号。
9. 使用中文，不要夹杂其他语言。

评价标签：${text}

请直接返回润色后的点评内容，不需要其他说明。`;

        // 调用 Cloudflare Workers AI
        const aiResponse = await env.AI.run('@cf/google/gemma-3-12b-it', {
          messages: [
            {
              role: 'system',
              content: '你是一个专业的餐厅点评润色助手，擅长将简单的标签转化为自然流畅的点评文字。'
            },
            {
              role: 'user',
              content: prompt // 使用后端定义的 prompt
            }
          ],
          max_tokens: 400,
          temperature: 0.9
        });

        return new Response(JSON.stringify(aiResponse), { // 返回 AI 的完整响应
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });

      } catch (error) {
        console.error('AI处理错误:', error);
        return new Response(JSON.stringify({
          error: 'AI服务暂时不可用',
          details: error.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });
      }
    }

    // 如果是根路径，返回 HTML 文件
    if (new URL(request.url).pathname === '/') {
      return new Response('Worker is running', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 发送数据到Webhook
async function sendToWebhook(selectedLabels, env) {
  try {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    
    const payload = {
      timestamp: beijingTime.toISOString(),
      date: beijingTime.toISOString().split('T')[0],
      time: beijingTime.toTimeString().split(' ')[0],
      selectedLabels: selectedLabels,
      // 可以添加更多元数据
      source: 'dianping-agent',
      version: '1.0'
    };

    // 发送到主webhook
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DianpingAgent/1.0'
      },
      body: JSON.stringify(payload)
    });

    // 如果配置了备用webhook，也发送一份
    if (env.BACKUP_WEBHOOK_URL) {
      await fetch(env.BACKUP_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });
    }

  } catch (error) {
    console.error('Webhook发送失败:', error);
    // 可以记录到其他地方或发送告警
  }
}

// 提交数据到Google Form
async function submitToGoogleForm(selectedLabels, selectedTags, env) {
  try {
    // 检查是否配置了Google Form URL
    if (!env.GOOGLE_FORM_URL) {
      console.log('Google Form URL未配置，跳过提交');
      return;
    }

    const now = new Date();
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    
    // 准备表单数据
    const formData = new FormData();
    
    // 根据你的Google Form字段名称来设置这些entry值
    // 你需要替换这些entry ID为你实际的Google Form字段ID
    formData.append('entry.218313468', beijingTime.toISOString()); // 时间戳字段
    formData.append('entry.1273374526', selectedLabels.join(', ')); // 选中标签字段
    formData.append('entry.1493587175', selectedTags.join('，')); // 评价文本字段
    formData.append('entry.89095521', beijingTime.toISOString().split('T')[0]); // 日期字段
    formData.append('entry.1356066148', beijingTime.toTimeString().split(' ')[0]); // 时间字段
    
    // 添加分类统计
    const categories = categorizeLabels(selectedLabels);
    formData.append('entry.742681247', categories.environment.join(', ')); // 环境评价
    formData.append('entry.1774805571', categories.taste.join(', ')); // 口味评价
    formData.append('entry.1751902647', categories.service.join(', ')); // 服务评价
    formData.append('entry.1079371495', categories.price.join(', ')); // 价格评价
    formData.append('entry.782192759', categories.overall.join(', ')); // 综合评价

    // 提交到Google Form
    const response = await fetch(env.GOOGLE_FORM_URL, {
      method: 'POST',
      body: formData,
      headers: {
        'User-Agent': 'DianpingAgent/1.0'
      }
    });

    if (response.ok) {
      console.log('Google Form提交成功');
    } else {
      console.error('Google Form提交失败:', response.status, response.statusText);
    }

  } catch (error) {
    console.error('Google Form提交出错:', error);
    // 不抛出错误，避免影响主要功能
  }
}

// 将标签按类别分组
function categorizeLabels(selectedLabels) {
  const categories = {
    environment: [],
    taste: [],
    service: [],
    price: [],
    overall: []
  };

  // 定义各类别的标签映射
  const labelCategories = {
    // 环境相关
    '环境舒适': 'environment',
    '装修特色': 'environment',
    '很接地气': 'environment',
    '位置便利': 'environment',
    '干净整洁': 'environment',
    '环境一般': 'environment',
    '装修老旧': 'environment',
    '环境嘈杂': 'environment',
    
    // 口味相关
    '味道正宗': 'taste',
    '口感不错': 'taste',
    '分量很足': 'taste',
    '创新独特': 'taste',
    '口味中规': 'taste',
    '有点辣了': 'taste',
    '分量适中': 'taste',
    '分量偏少': 'taste',
    
    // 服务相关
    '服务周到': 'service',
    '上菜很快': 'service',
    '态度很好': 'service',
    '老板亲切': 'service',
    '主动推荐': 'service',
    '服务一般': 'service',
    '上菜略慢': 'service',
    '态度冷淡': 'service',
    
    // 价格相关
    '价格实惠': 'price',
    '性价比高': 'price',
    '价位适中': 'price',
    '有点小贵': 'price',
    '性价比低': 'price',
    
    // 综合相关
    '总体满意': 'overall',
    '值得推荐': 'overall',
    '附近最好': 'overall',
    '下次再来': 'overall',
    '超出预期': 'overall',
    '体验还行': 'overall',
    '可以尝试': 'overall',
    '有待提高': 'overall'
  };

  // 将标签分配到对应类别
  selectedLabels.forEach(label => {
    const category = labelCategories[label];
    if (category && categories[category]) {
      categories[category].push(label);
    }
  });

  return categories;
}
