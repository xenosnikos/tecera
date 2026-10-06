import type { FixtureSpec } from '../fixtureFetch.js';

/**
 * Hand-written openai API responses served by FixtureFetch (`'openai/<case>'`). They are compiled into
 * dist, so the bundled fixtures work from an installed package, not only from a checkout. `{{AUTH}}`
 * is replaced by the request's auth header value (a provider echoing the credential).
 */
export const OPENAI_FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  "ok": {
    "status": 200,
    "body": {
      "id": "resp_fixture_ok",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "reasoning",
          "id": "rs_1",
          "summary": []
        },
        {
          "type": "message",
          "id": "msg_1",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "Hello from GPT.",
              "annotations": []
            }
          ]
        }
      ],
      "incomplete_details": null,
      "error": null,
      "usage": {
        "input_tokens": 1000,
        "output_tokens": 500,
        "output_tokens_details": {
          "reasoning_tokens": 200
        },
        "total_tokens": 1500
      }
    }
  },
  "schema": {
    "status": 200,
    "body": {
      "id": "resp_fixture_schema",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_2",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 400,
        "output_tokens": 30,
        "total_tokens": 430
      }
    }
  },
  "length": {
    "status": 200,
    "body": {
      "id": "resp_fixture_length",
      "object": "response",
      "status": "incomplete",
      "model": "gpt-5.6-sol",
      "incomplete_details": {
        "reason": "max_output_tokens"
      },
      "output": [
        {
          "type": "message",
          "id": "msg_3",
          "role": "assistant",
          "status": "incomplete",
          "content": [
            {
              "type": "output_text",
              "text": "partial",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 10,
        "output_tokens": 16,
        "total_tokens": 26
      }
    }
  },
  "refusal": {
    "status": 200,
    "body": {
      "id": "resp_fixture_refusal",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_4",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "refusal",
              "refusal": "I can't help with that."
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 10,
        "output_tokens": 8,
        "total_tokens": 18
      }
    }
  },
  "429": {
    "status": 429,
    "body": {
      "error": {
        "message": "Rate limit reached for requests",
        "type": "requests",
        "code": "rate_limit_exceeded"
      }
    }
  },
  "500": {
    "status": 500,
    "body": {
      "error": {
        "message": "The server had an error while processing your request.",
        "type": "server_error"
      }
    }
  },
  "malformed": {
    "status": 200,
    "bodyText": "<html>502 Bad Gateway</html>"
  },
  "wrong-shape": {
    "status": 200,
    "body": {
      "choices": []
    }
  },
  "echo-auth": {
    "status": 401,
    "body": {
      "error": {
        "message": "Incorrect API key provided: {{AUTH}}. You can find your API key at https://platform.openai.com/account/api-keys.",
        "type": "invalid_request_error",
        "code": "invalid_api_key"
      }
    }
  },
  "hang": {
    "status": 200,
    "delayMs": 60000,
    "body": {}
  },
  "in-progress": {
    "status": 200,
    "body": {
      "id": "resp_fixture_in_progress",
      "object": "response",
      "status": "in_progress",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "assistant",
          "status": "in_progress",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "in-progress-message": {
    "status": 200,
    "body": {
      "id": "resp_fixture_in_progress_msg",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "assistant",
          "status": "in_progress",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "user-role": {
    "status": 200,
    "body": {
      "id": "resp_fixture_user_role",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "user",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "fragmented": {
    "status": 200,
    "body": {
      "id": "resp_fixture_fragmented",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_a",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"appr",
              "annotations": []
            }
          ]
        },
        {
          "type": "message",
          "id": "msg_b",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "ove\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "two-parts-schema": {
    "status": 200,
    "body": {
      "id": "resp_fixture_two_parts",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_c",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"reject\",\"findings\":[{\"title\":\"x\"}]}",
              "annotations": []
            },
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "function-call": {
    "status": 200,
    "body": {
      "id": "resp_fixture_function_call",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            }
          ]
        },
        {
          "type": "function_call",
          "id": "fc_1",
          "call_id": "call_1",
          "name": "run_shell",
          "arguments": "{\"cmd\":\"git push\"}",
          "status": "completed"
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "unknown-part": {
    "status": 200,
    "body": {
      "id": "resp_fixture_unknown_part",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_d",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "{\"verdict\":\"approve\",\"findings\":[]}",
              "annotations": []
            },
            {
              "type": "output_audio",
              "data": "AAAA"
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "empty": {
    "status": 200,
    "body": {
      "id": "resp_fixture_empty",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "reasoning",
          "id": "rs_1",
          "summary": []
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "echo-content": {
    "status": 200,
    "body": {
      "id": "resp_fixture_echo_content",
      "object": "response",
      "status": "completed",
      "model": "gpt-5.6-terra",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "your key: {{AUTH}}",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  },
  "echo-model": {
    "status": 200,
    "body": {
      "id": "resp_fixture_echo_model",
      "object": "response",
      "status": "completed",
      "model": "{{AUTH}}",
      "output": [
        {
          "type": "message",
          "id": "msg_x",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "hello",
              "annotations": []
            }
          ]
        }
      ],
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120
      }
    }
  }
};
