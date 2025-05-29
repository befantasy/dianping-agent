// Helper function to append data to Google Sheets
async function appendToGoogleSheet(env, spreadsheetId, sheetName, apiKey, values) {
  // Construct the API URL for appending values
  // The range ${sheetName} means it will append to the first empty row of the specified sheet.
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}!A1:append?valueInputOption=USER_ENTERED&key=${apiKey}`;

  // Prepare the request body
  const body = {
    majorDimension: 'ROWS',
    values: values, // values should be an array of arrays, e.g., [["timestamp1", "tag1"], ["timestamp2", "tag2"]]
  };

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('Google Sheets API Error:', responseData.error ? responseData.error.message : 'Unknown error', 'Status:', response.status);
      // You might want to add more robust error logging or retry mechanisms here
    } else {
      console.log('Data successfully appended to Google Sheet:', responseData.updates.updatedRange);
    }
  } catch (error) {
    console.error('Error appending to Google Sheet:', error.message, error.stack);
  }
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Selected-Tags', // Allow custom header if you pass tags this way
        },
      });
    }

    // Handle API request for polishing review
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/polish-review') {
      try {
        // Get text and selectedTags from the request body
        // Ensure your frontend sends `selectedTags` as an array of strings
        const { text, selectedTags } = await request.json();

        if (!text) {
          return new Response(JSON.stringify({ error: 'Missing "text" in request body' }), {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            }
          });
        }

        // Your existing prompt for the AI
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

        // Call Cloudflare Workers AI
        const aiResponsePromise = env.AI.run('@cf/google/gemma-3-12b-it', {
          messages: [
            {
              role: 'system',
              content: '你是一个专业的餐厅点评润色助手，擅长将简单的标签转化为自然流畅的点评文字。'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 400,
          temperature: 0.9
        });

        // Process Google Sheets update if selectedTags are provided
        if (env.GOOGLE_SHEETS_API_KEY && env.SPREADSHEET_ID && env.SHEET_NAME && Array.isArray(selectedTags) && selectedTags.length > 0) {
          const timestamp = new Date().toISOString();
          const rowsToAppend = selectedTags.map(tag => [timestamp, tag]); // Each tag gets its own row with the same timestamp

          // Use ctx.waitUntil to perform the action without blocking the response
          ctx.waitUntil(
            appendToGoogleSheet(
              env,
              env.SPREADSHEET_ID,
              env.SHEET_NAME,
              env.GOOGLE_SHEETS_API_KEY,
              rowsToAppend
            )
          );
        } else {
          if (!env.GOOGLE_SHEETS_API_KEY || !env.SPREADSHEET_ID || !env.SHEET_NAME) {
            console.warn('Google Sheets environment variables (GOOGLE_SHEETS_API_KEY, SPREADSHEET_ID, SHEET_NAME) are not configured. Skipping sheet update.');
          }
          if (!Array.isArray(selectedTags) || selectedTags.length === 0) {
            console.log('No selectedTags provided or tags array is empty. Skipping sheet update.');
          }
        }
        
        const aiResponse = await aiResponsePromise;

        return new Response(JSON.stringify(aiResponse), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          }
        });

      } catch (error) {
        console.error('AI处理或主逻辑错误:', error.message, error.stack);
        return new Response(JSON.stringify({
          error: '服务暂时不可用',
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

    // If it's the root path, return a simple message
    if (new URL(request.url).pathname === '/') {
      return new Response('Worker is running and ready to polish reviews and log tags to Google Sheets.', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Return Not Found for other paths
    return new Response('Not Found', { status: 404 });
  }
};
