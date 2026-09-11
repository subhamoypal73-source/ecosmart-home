const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase environment variables.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// --------------------------------------------------
// Authentication
// --------------------------------------------------

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function deviceAuth(req, res, next) {
  const token = req.headers["x-device-token"];

  if (!DEVICE_TOKEN || token !== DEVICE_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized device"
    });
  }

  next();
}

// --------------------------------------------------
// Basic health check
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "EcoSmart Home Cloud API",
    time: new Date().toISOString()
  });
});

// --------------------------------------------------
// Process scheduled timers
// --------------------------------------------------

async function processTimers() {
  const now = new Date().toISOString();

  const { data: timers, error } = await supabase
    .from("timers")
    .select("*")
    .eq("active", true)
    .lte("execute_at", now)
    .order("execute_at", { ascending: true });

  if (error) {
    console.error("Timer query error:", error.message);
    return;
  }

  if (!timers || timers.length === 0) {
    return;
  }

  for (const timer of timers) {
    const { error: updateError } = await supabase
      .from("appliances")
      .update({
        desired_state: timer.target_state
      })
      .eq("id", timer.appliance_id);

    if (updateError) {
      console.error(
        "Timer appliance update error:",
        updateError.message
      );
      continue;
    }

    // Timer control of Room Light disables automatic LDR mode.
    if (timer.appliance_id === 0) {
      await supabase
        .from("settings")
        .update({
          room_auto: false
        })
        .eq("id", 1);
    }

    await supabase
      .from("timers")
      .update({
        active: false
      })
      .eq("id", timer.id);
  }
}

// --------------------------------------------------
// ESP8266 asks for current desired states
// --------------------------------------------------

app.get("/api/device/state", deviceAuth, async (req, res) => {
  try {
    await processTimers();

    const { data: appliances, error } = await supabase
      .from("appliances")
      .select(
        "id,name,desired_state,reported_state,runtime_seconds"
      )
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    const { data: settings, error: settingsError } =
      await supabase
        .from("settings")
        .select("room_auto")
        .eq("id", 1)
        .single();

    if (settingsError) {
      return res.status(500).json({
        error: settingsError.message
      });
    }

    // Latest runtime reset IDs.
    const resetIds = {};

    for (const appliance of appliances || []) {
      const { data: resetData } = await supabase
        .from("runtime_resets")
        .select("id")
        .eq("appliance_id", appliance.id)
        .order("id", { ascending: false })
        .limit(1);

      resetIds[appliance.id] =
        resetData && resetData.length
          ? resetData[0].id
          : 0;
    }

    res.json({
      ok: true,

      states: (appliances || []).map((a) => ({
        id: a.id,
        state: !!a.desired_state
      })),

      roomAuto: !!settings.room_auto,

      resetIds: resetIds
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Server error"
    });
  }
});

// --------------------------------------------------
// ESP8266 reports its current status
// --------------------------------------------------

app.post("/api/device/report", deviceAuth, async (req, res) => {
  try {
    const body = req.body || {};

    const states = Array.isArray(body.states)
      ? body.states
      : [];

    const runtimeSeconds =
      body.runtimeSeconds || {};

    const ldr =
      Number.isFinite(Number(body.ldr))
        ? Number(body.ldr)
        : null;

    const uptime =
      Number.isFinite(Number(body.uptime))
        ? Number(body.uptime)
        : null;

    for (let id = 0; id < 4; id++) {
      const state =
        states[id] === true ||
        states[id] === 1;

      const runtime =
        Number(runtimeSeconds[id] || 0);

      await supabase
        .from("appliances")
        .update({
          reported_state: state,
          runtime_seconds: runtime,
          last_seen: new Date().toISOString(),
          online: true
        })
        .eq("id", id);
    }

    await supabase
      .from("devices")
      .update({
        last_seen: new Date().toISOString(),
        online: true,
        ldr_value: ldr,
        uptime_seconds: uptime
      })
      .eq("id", 1);

    if (typeof body.roomAuto === "boolean") {
      await supabase
        .from("settings")
        .update({
          room_auto: body.roomAuto
        })
        .eq("id", 1);
    }

    res.json({
      ok: true,
      received: true
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Report failed"
    });
  }
});

// --------------------------------------------------
// Dashboard data
// --------------------------------------------------

app.get("/api/dashboard", adminAuth, async (req, res) => {
  try {
    await processTimers();

    const { data: appliances, error } = await supabase
      .from("appliances")
      .select("*")
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    const { data: settings } = await supabase
      .from("settings")
      .select("*")
      .eq("id", 1)
      .single();

    const { data: timers } = await supabase
      .from("timers")
      .select("*")
      .eq("active", true)
      .order("execute_at", { ascending: true });

    const { data: device } = await supabase
      .from("devices")
      .select("*")
      .eq("id", 1)
      .single();

    res.json({
      ok: true,
      appliances: appliances || [],
      settings: settings || {},
      timers: timers || [],
      device: device || null
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Dashboard error"
    });
  }
});

// --------------------------------------------------
// Manual appliance ON/OFF control
// --------------------------------------------------

app.post(
  "/api/control/:id",
  adminAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (![0, 1, 2, 3].includes(id)) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }

      const state = !!req.body.state;

      const { error } = await supabase
        .from("appliances")
        .update({
          desired_state: state
        })
        .eq("id", id);

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      // Manual Room Light control disables LDR auto mode.
      if (id === 0) {
        await supabase
          .from("settings")
          .update({
            room_auto: false
          })
          .eq("id", 1);
      }

      res.json({
        ok: true,
        appliance: id,
        state: state
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Control failed"
      });
    }
  }
);

// --------------------------------------------------
// Room Light automatic LDR mode
// --------------------------------------------------

app.post(
  "/api/room-auto",
  adminAuth,
  async (req, res) => {
    try {
      const enabled = !!req.body.enabled;

      const { error } = await supabase
        .from("settings")
        .update({
          room_auto: enabled
        })
        .eq("id", 1);

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      res.json({
        ok: true,
        roomAuto: enabled
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Room auto update failed"
      });
    }
  }
);

// --------------------------------------------------
// Create timer
// --------------------------------------------------

app.post(
  "/api/timer/:id",
  adminAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const minutes =
        Number(req.body.minutes);

      const targetState =
        !!req.body.state;

      if (![0, 1, 2, 3].includes(id)) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }

      if (
        !Number.isFinite(minutes) ||
        minutes <= 0 ||
        minutes > 10080
      ) {
        return res.status(400).json({
          error: "Minutes must be between 1 and 10080"
        });
      }

      // Remove previous active timers for this appliance.
      await supabase
        .from("timers")
        .update({
          active: false
        })
        .eq("appliance_id", id)
        .eq("active", true);

      const executeAt =
        new Date(
          Date.now() + minutes * 60 * 1000
        ).toISOString();

      const { data, error } = await supabase
        .from("timers")
        .insert({
          appliance_id: id,
          target_state: targetState,
          execute_at: executeAt,
          active: true
        })
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      // Timer for Room Light disables LDR automatic mode.
      if (id === 0) {
        await supabase
          .from("settings")
          .update({
            room_auto: false
          })
          .eq("id", 1);
      }

      res.json({
        ok: true,
        timer: data
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Timer creation failed"
      });
    }
  }
);

// --------------------------------------------------
// Cancel timer
// --------------------------------------------------

app.delete(
  "/api/timer/:id",
  adminAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const { error } = await supabase
        .from("timers")
        .update({
          active: false
        })
        .eq("id", id);

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      res.json({
        ok: true,
        cancelled: id
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Timer cancellation failed"
      });
    }
  }
);

// --------------------------------------------------
// Erase runtime
// --------------------------------------------------

app.post(
  "/api/erase/:id",
  adminAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (![0, 1, 2, 3].includes(id)) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }

      // Store a reset event so ESP8266 can also
      // clear its local runtime counter.
      const { data: reset, error: resetError } =
        await supabase
          .from("runtime_resets")
          .insert({
            appliance_id: id
          })
          .select()
          .single();

      if (resetError) {
        return res.status(500).json({
          error: resetError.message
        });
      }

      const { error } = await supabase
        .from("appliances")
        .update({
          runtime_seconds: 0
        })
        .eq("id", id);

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      res.json({
        ok: true,
        appliance: id,
        resetId: reset.id
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error: "Runtime reset failed"
      });
    }
  }
);

// --------------------------------------------------
// Root page
// --------------------------------------------------

app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>EcoSmart Home</title>
      </head>
      <body>
        <h1>EcoSmart Home Cloud API</h1>
        <p>Cloud server is running.</p>
        <p>ESP8266 API is ready.</p>
      </body>
    </html>
  `);
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `EcoSmart Home server running on port ${PORT}`
  );
});
