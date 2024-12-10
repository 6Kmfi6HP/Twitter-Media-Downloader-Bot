const API_BASE = 'https://x-video-dl.pages.dev/api/twitter';

export async function downloadTwitterMedia(url: string) {
  try {
    const response = await fetch(`${API_BASE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch tweet data: ${response.statusText}`);
    }

    console.log('原始响应:', response);
    
    const data = await response.json();
    console.log('响应数据:', data);

    return data;
  } catch (error) {
    console.error('Error downloading Twitter media:', error);
    throw error;
  }
}