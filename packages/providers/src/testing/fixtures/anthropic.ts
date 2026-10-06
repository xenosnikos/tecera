import type { FixtureSpec } from '../fixtureFetch.js';

/**
 * Hand-written anthropic API responses served by FixtureFetch (`'anthropic/<case>'`). They are compiled into
 * dist, so the bundled fixtures work from an installed package, not only from a checkout. `{{AUTH}}`
 * is replaced by the request's auth header value (a provider echoing the credential).
 */
export const ANTHROPIC_FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  "ok": {
    "status": 200,
    "body": {
      "id": "msg_fixture_ok",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "thinking",
          "thinking": "",
          "signature": "sig_fixture"
        },
        {
          "type": "text",
          "text": "Hello from Claude."
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 1200,
        "output_tokens": 300
      }
    }
  },
  "schema": {
    "status": 200,
    "body": {
      "id": "msg_fixture_schema",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"approve\",\"findings\":[]}"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 500,
        "output_tokens": 20
      }
    }
  },
  "tool": {
    "status": 200,
    "body": {
      "id": "msg_fixture_tool",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "emit_output",
          "input": {
            "verdict": "reject",
            "findings": [
              {
                "title": "x"
              }
            ]
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 40
      }
    }
  },
  "cached": {
    "status": 200,
    "body": {
      "id": "msg_fixture_cached",
      "type": "message",
      "role": "assistant",
      "model": "claude-opus-5-5",
      "content": [
        {
          "type": "text",
          "text": "cached"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 1000,
        "output_tokens": 1000,
        "cache_creation_input_tokens": 2000,
        "cache_read_input_tokens": 10000
      }
    }
  },
  "length": {
    "status": 200,
    "body": {
      "id": "msg_fixture_length",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "partial"
        }
      ],
      "stop_reason": "max_tokens",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 10,
        "output_tokens": 16
      }
    }
  },
  "refusal": {
    "status": 200,
    "body": {
      "id": "msg_fixture_refusal",
      "type": "message",
      "role": "assistant",
      "model": "claude-opus-5-5",
      "content": [],
      "stop_reason": "refusal",
      "stop_details": {
        "type": "refusal",
        "category": "cyber",
        "explanation": "declined"
      },
      "usage": {
        "input_tokens": 50,
        "output_tokens": 0
      }
    }
  },
  "429": {
    "status": 429,
    "headers": {
      "retry-after": "1"
    },
    "body": {
      "type": "error",
      "error": {
        "type": "rate_limit_error",
        "message": "Number of requests has exceeded your rate limit."
      }
    }
  },
  "500": {
    "status": 500,
    "body": {
      "type": "error",
      "error": {
        "type": "api_error",
        "message": "Internal server error"
      }
    }
  },
  "529": {
    "status": 529,
    "body": {
      "type": "error",
      "error": {
        "type": "overloaded_error",
        "message": "Overloaded"
      }
    }
  },
  "400": {
    "status": 400,
    "body": {
      "type": "error",
      "error": {
        "type": "invalid_request_error",
        "message": "max_tokens: field required"
      }
    }
  },
  "malformed": {
    "status": 200,
    "bodyText": "{\"id\":\"msg_trunc\",\"content\":[{\"type\":\"text\",\"te"
  },
  "wrong-shape": {
    "status": 200,
    "body": {
      "hello": "world"
    }
  },
  "echo-auth": {
    "status": 401,
    "body": {
      "type": "error",
      "error": {
        "type": "authentication_error",
        "message": "invalid x-api-key: {{AUTH}}"
      }
    }
  },
  "hang": {
    "status": 200,
    "delayMs": 60000,
    "body": {}
  },
  "user-role": {
    "status": 200,
    "body": {
      "id": "msg_fixture_user_role",
      "type": "message",
      "role": "user",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"approve\",\"findings\":[]}"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "conflicting-tools": {
    "status": 200,
    "body": {
      "id": "msg_fixture_conflict",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "emit_output",
          "input": {
            "verdict": "reject",
            "findings": [
              {
                "title": "x"
              }
            ]
          }
        },
        {
          "type": "tool_use",
          "id": "toolu_2",
          "name": "emit_output",
          "input": {
            "verdict": "approve",
            "findings": []
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "tool-and-other": {
    "status": 200,
    "body": {
      "id": "msg_fixture_tool_other",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "emit_output",
          "input": {
            "verdict": "approve",
            "findings": []
          }
        },
        {
          "type": "tool_use",
          "id": "toolu_2",
          "name": "run_shell",
          "input": {
            "cmd": "git push"
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "tool-with-text": {
    "status": 200,
    "body": {
      "id": "msg_fixture_tool_text",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"approve\",\"findings\":[]}"
        },
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "emit_output",
          "input": {
            "verdict": "reject",
            "findings": [
              {
                "title": "x"
              }
            ]
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "two-text-schema": {
    "status": 200,
    "body": {
      "id": "msg_fixture_two_text",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"appr"
        },
        {
          "type": "text",
          "text": "ove\",\"findings\":[]}"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "unsupported-block": {
    "status": 200,
    "body": {
      "id": "msg_fixture_unsupported",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "ok"
        },
        {
          "type": "server_tool_use",
          "id": "srvtoolu_1",
          "name": "web_search",
          "input": {
            "query": "x"
          }
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "pause": {
    "status": 200,
    "body": {
      "id": "msg_fixture_pause",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"approve\",\"findings\":[]}"
        }
      ],
      "stop_reason": "pause_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "stop-sequence": {
    "status": 200,
    "body": {
      "id": "msg_fixture_stopseq",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "{\"verdict\":\"approve\",\"findings\":[]}"
        }
      ],
      "stop_reason": "stop_sequence",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "empty": {
    "status": 200,
    "body": {
      "id": "msg_fixture_empty",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "thinking",
          "thinking": "",
          "signature": "sig"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "echo-content": {
    "status": 200,
    "body": {
      "id": "msg_fixture_echo_content",
      "type": "message",
      "role": "assistant",
      "model": "claude-sonnet-5",
      "content": [
        {
          "type": "text",
          "text": "Here is your key: {{AUTH}}"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "echo-model": {
    "status": 200,
    "body": {
      "id": "msg_fixture_echo_model",
      "type": "message",
      "role": "assistant",
      "model": "{{AUTH}}",
      "content": [
        {
          "type": "text",
          "text": "hello"
        }
      ],
      "stop_reason": "end_turn",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  },
  "echo-tool-input": {
    "status": 200,
    "body": {
      "id": "msg_fixture_echo_tool",
      "type": "message",
      "role": "assistant",
      "model": "claude-haiku-4-5-20251001",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_1",
          "name": "emit_output",
          "input": {
            "verdict": "approve",
            "findings": [
              {
                "title": "{{AUTH}}"
              }
            ]
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": {
        "input_tokens": 100,
        "output_tokens": 20
      }
    }
  }
};
