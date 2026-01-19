
const WEBHOOK_URL = 'https://n8n.riyadah.com.eg/webhook/8c5879b7-c4d6-4da1-82e2-f42b51fb1dae/chat';
const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbzKruxQQX9r3Bav0wu7F1BwGvunXV1Kmu5ty44WDATTsucNvBREe7zFtqA0TlOSfqXfdg/exec';

export async function queryKnowledgeBase(query: string, sessionId: string): Promise<any> {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        query,
        chatInput: query,
        message: query,
        sessionId,
        action: 'chat',
        timestamp: new Date().toISOString()
      }),
    });

    if (!response.ok) {
      throw new Error(`Knowledge base error: ${response.status}`);
    }

    return await response.json();
  } catch (error: any) {
    throw error;
  }
}

export async function submitSupportAction(data: {
  messageType: 'Booking' | 'Support Ticket' | 'Sales Query';
  actionDone: 'Appointment Scheduled' | 'Support Ticket Logged' | 'Sales info Delivered';
  clientName: string;
  phone: string;
  email: string;
  topic: string;
}): Promise<any> {
  try {
    // The Google Apps Script provided expects:
    // data.type
    // data.title
    // data.details (which it stringifies)

    const payload = {
      type: data.messageType,
      title: data.actionDone,
      details: {
        clientName: data.clientName,
        phone: data.phone,
        email: data.email,
        topic: data.topic,
        loggedAt: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Cairo' })
      }
    };

    // Using text/plain to avoid CORS preflight (OPTIONS) which Google Apps Script doesn't handle well.
    // The script will receive the raw string in e.postData.contents and JSON.parse it.
    await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify(payload),
    });

    return { status: 'success' };
  } catch (error) {
    console.error('Logging Error:', error);
    throw new Error('Failed to log action to system.');
  }
}
