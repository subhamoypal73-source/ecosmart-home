const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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

if (!DEVICE_TOKEN) {
  console.error("Missing DEVICE_TOKEN environment variable.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);


// =====================================================
// DASHBOARD ACCESS CODE
// =====================================================

let dashboardCodeHash = null;
let dashboardCodeSalt = null;

function hashCode(code, salt) {
  return crypto
    .scryptSync(code, salt, 64)
    .toString("hex");
}

function verifyCode(code) {
  if (!dashboardCodeHash || !dashboardCodeSalt) {
    return false;
  }

  try {
    const calculated = hashCode(
      code,
      dashboardCodeSalt
    );

    return crypto.timingSafeEqual(
      Buffer.from(calculated, "hex"),
      Buffer.from(dashboardCodeHash, "hex")
    );
  } catch {
    return false;
  }
}

async function initializeDashboardAuth() {
  const { data, error } = await supabase
    .from("dashboard_auth")
    .select("code_hash, code_salt")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error(
      "Dashboard auth database error:",
      error.message
    );
    process.exit(1);
  }

  // First time only:
  // Render ADMIN_TOKEN becomes the initial dashboard code.
  if (!data) {
    if (!ADMIN_TOKEN) {
      console.error(
        "ADMIN_TOKEN is required for first dashboard setup."
      );
      process.exit(1);
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashCode(ADMIN_TOKEN, salt);

    const { error: insertError } = await supabase
      .from("dashboard_auth")
      .insert({
        id: 1,
        code_hash: hash,
        code_salt: salt
      });

    if (insertError) {
      console.error(
        "Dashboard auth creation failed:",
        insertError.message
      );
      process.exit(1);
    }

    dashboardCodeHash = hash;
    dashboardCodeSalt = salt;

    console.log(
      "Dashboard access code initialized from ADMIN_TOKEN."
    );

    return;
  }

  dashboardCodeHash = data.code_hash;
  dashboardCodeSalt = data.code_salt;

  console.log("Dashboard access code loaded.");
}


// =====================================================
// AUTHENTICATION
// =====================================================

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"];

  if (
    typeof token !== "string" ||
    !verifyCode(token)
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}


function deviceAuth(req, res, next) {
  const token = req.headers["x-device-token"];

  if (
    !DEVICE_TOKEN ||
    token !== DEVICE_TOKEN
  ) {
    return res.status(401).json({
      error: "Unauthorized device"
    });
  }

  next();
}


// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "EcoSmart Home Cloud API",
    time: new Date().toISOString()
  });
});


// =====================================================
// TIMER PROCESSING
// =====================================================

async function processTimers() {
  const now = new Date().toISOString();

  const { data: timers, error } = await supabase
    .from("timers")
    .select("*")
    .eq("active", true)
    .lte("execute_at", now)
    .order("execute_at", {
      ascending: true
    });

  if (error) {
    console.error(
      "Timer query error:",
      error.message
    );
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

    // Room Light timer disables automatic mode.
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


// =====================================================
// ENERGY HISTORY
// =====================================================

async function recordEnergyUsage(
  applianceId,
  currentRuntime
) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const { data: appliance, error } = await supabase
    .from("appliances")
    .select(
      "power_w,history_date,history_baseline_runtime_seconds,history_initialized"
    )
    .eq("id", applianceId)
    .single();

  if (error || !appliance) {
    return;
  }

  const runtime = Math.max(
    0,
    Number(currentRuntime || 0)
  );

  const powerW =
    appliance.power_w === null ||
    appliance.power_w === undefined
      ? 0
      : Number(appliance.power_w);

  // First report after this feature is installed.
  // We initialize the baseline without creating fake history.
  if (!appliance.history_initialized) {

    await supabase
      .from("appliances")
      .update({
        history_date: today,
        history_baseline_runtime_seconds: runtime,
        history_initialized: true
      })
      .eq("id", applianceId);

    return;
  }

  const oldDate =
    appliance.history_date
      ? String(appliance.history_date)
      : today;

  const oldRuntime = Math.max(
    0,
    Number(
      appliance.history_baseline_runtime_seconds || 0
    )
  );

  // Runtime became smaller:
  // probably Erase Time / ESP reset.
  if (runtime < oldRuntime) {

    await supabase
      .from("appliances")
      .update({
        history_date: today,
        history_baseline_runtime_seconds: runtime,
        history_initialized: true
      })
      .eq("id", applianceId);

    return;
  }

  const deltaSeconds =
    runtime - oldRuntime;

  // No new runtime.
  if (deltaSeconds <= 0) {

    await supabase
      .from("appliances")
      .update({
        history_date: today,
        history_baseline_runtime_seconds: runtime
      })
      .eq("id", applianceId);

    return;
  }

  /*
    Estimated energy:

    Energy (Wh)
    =
    Power (W) × Runtime (hours)

    Example:
    9 W × 1 hour = 9 Wh
  */

  const energyWh =
    (deltaSeconds / 3600) * powerW;

  /*
    If the date changed, this implementation assigns
    the newly reported runtime delta to today's record.

    This is suitable for the prototype and avoids
    inventing exact midnight usage.
  */

  const historyDate = today;

  const { data: existing } = await supabase
    .from("energy_history")
    .select(
      "runtime_seconds,energy_wh"
    )
    .eq("appliance_id", applianceId)
    .eq("usage_date", historyDate)
    .maybeSingle();

  if (existing) {

    const newRuntime =
      Number(existing.runtime_seconds || 0)
      + deltaSeconds;

    const newEnergy =
      Number(existing.energy_wh || 0)
      + energyWh;

    await supabase
      .from("energy_history")
      .update({
        runtime_seconds: newRuntime,
        energy_wh: newEnergy,
        updated_at: new Date().toISOString()
      })
      .eq("appliance_id", applianceId)
      .eq("usage_date", historyDate);

  } else {

    await supabase
      .from("energy_history")
      .insert({
        appliance_id: applianceId,
        usage_date: historyDate,
        runtime_seconds: deltaSeconds,
        energy_wh: energyWh
      });
  }

  await supabase
    .from("appliances")
    .update({
      history_date: today,
      history_baseline_runtime_seconds: runtime,
      history_initialized: true,
      energy_wh: energyWh
    })
    .eq("id", applianceId);
}


// =====================================================
// DEVICE STATE
// ESP8266 GETS CLOUD COMMANDS HERE
// =====================================================

app.get(
  "/api/device/state",
  deviceAuth,
  async (req, res) => {

    try {

      await processTimers();

      const { data: appliances, error } =
        await supabase
          .from("appliances")
          .select(
            "id,name,desired_state,reported_state,runtime_seconds"
          )
          .order("id", {
            ascending: true
          });

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }

      const {
        data: settings,
        error: settingsError
      } = await supabase
        .from("settings")
        .select("room_auto")
        .eq("id", 1)
        .single();

      if (settingsError) {
        return res.status(500).json({
          error: settingsError.message
        });
      }

      const resetIds = {};

      for (const appliance of appliances || []) {

        const { data: resetData } =
          await supabase
            .from("runtime_resets")
            .select("id")
            .eq(
              "appliance_id",
              appliance.id
            )
            .order("id", {
              ascending: false
            })
            .limit(1);

        resetIds[appliance.id] =
          resetData &&
          resetData.length
            ? resetData[0].id
            : 0;
      }

      res.json({
        ok: true,

        states:
          (appliances || []).map(a => ({
            id: a.id,
            state: !!a.desired_state
          })),

        roomAuto:
          !!settings.room_auto,

        resetIds
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: "Server error"
      });
    }
  }
);


// =====================================================
// DEVICE REPORT
// ESP8266 REPORTS REAL STATE / RUNTIME / LDR
// =====================================================

app.post(
  "/api/device/report",
  deviceAuth,
  async (req, res) => {

    try {

      const body = req.body || {};

      const states =
        Array.isArray(body.states)
          ? body.states
          : [];

      const runtimeSeconds =
        body.runtimeSeconds || {};

      const ldr =
        Number.isFinite(
          Number(body.ldr)
        )
          ? Number(body.ldr)
          : null;

      const uptime =
        Number.isFinite(
          Number(body.uptime)
        )
          ? Number(body.uptime)
          : null;


      // -----------------------------------------
      // Update appliance reported states
      // -----------------------------------------

      for (let id = 0; id < 4; id++) {

        const state =
          states[id] === true ||
          states[id] === 1;

        const runtime =
          Math.max(
            0,
            Number(
              runtimeSeconds[id] || 0
            )
          );

        await supabase
          .from("appliances")
          .update({
            reported_state: state,
            runtime_seconds: runtime,
            last_seen:
              new Date().toISOString(),
            online: true
          })
          .eq("id", id);

        // Record estimated energy history.
        await recordEnergyUsage(
          id,
          runtime
        );
      }


      // -----------------------------------------
      // Physical switch changes
      // -----------------------------------------

      const manualChanges =
        Array.isArray(body.manualChanges)
          ? body.manualChanges
          : [];

      for (const change of manualChanges) {

        const id =
          Number(change.id);

        if (
          ![0, 1, 2, 3].includes(id)
        ) {
          continue;
        }

        const state =
          change.state === true ||
          change.state === 1;

        await supabase
          .from("appliances")
          .update({
            desired_state: state
          })
          .eq("id", id);

        // Physical Room Light switch
        // disables automatic mode.
        if (id === 0) {

          await supabase
            .from("settings")
            .update({
              room_auto: false
            })
            .eq("id", 1);
        }
      }


      // -----------------------------------------
      // Device status
      // -----------------------------------------

      await supabase
        .from("devices")
        .update({
          last_seen:
            new Date().toISOString(),

          online: true,

          ldr_value: ldr,

          uptime_seconds: uptime
        })
        .eq("id", 1);


      // -----------------------------------------
      // Room Auto state from ESP
      // -----------------------------------------

      if (
        typeof body.roomAuto ===
        "boolean"
      ) {

        await supabase
          .from("settings")
          .update({
            room_auto:
              body.roomAuto
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
  }
);


// =====================================================
// DASHBOARD
// =====================================================

app.get(
  "/api/dashboard",
  adminAuth,
  async (req, res) => {

    try {

      await processTimers();

      const {
        data: appliances,
        error
      } = await supabase
        .from("appliances")
        .select("*")
        .order("id", {
          ascending: true
        });

      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }


      const { data: settings } =
        await supabase
          .from("settings")
          .select("*")
          .eq("id", 1)
          .single();


      const { data: timers } =
        await supabase
          .from("timers")
          .select("*")
          .eq("active", true)
          .order("execute_at", {
            ascending: true
          });


      const { data: device } =
        await supabase
          .from("devices")
          .select("*")
          .eq("id", 1)
          .single();


      // Today's energy
      const today =
        new Date()
          .toISOString()
          .slice(0, 10);

      const { data: todayHistory } =
        await supabase
          .from("energy_history")
          .select(
            "appliance_id,runtime_seconds,energy_wh"
          )
          .eq(
            "usage_date",
            today
          );


      const todayEnergy = {};

      for (
        const row
        of todayHistory || []
      ) {

        todayEnergy[row.appliance_id] =
          Number(row.energy_wh || 0);
      }


      res.json({

        ok: true,

        appliances:
          appliances || [],

        settings:
          settings || {},

        timers:
          timers || [],

        device:
          device || null,

        todayEnergy
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: "Dashboard error"
      });
    }
  }
);


// =====================================================
// APPLIANCE CONTROL
// =====================================================

app.post(
  "/api/control/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      if (
        ![0, 1, 2, 3].includes(id)
      ) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }

      const state =
        !!req.body.state;

      const { error } =
        await supabase
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


      // Manual Room Light control
      // disables Auto Mode.
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
        state
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: "Control failed"
      });
    }
  }
);


// =====================================================
// ROOM LIGHT AUTO MODE
// =====================================================

app.post(
  "/api/room-auto",
  adminAuth,
  async (req, res) => {

    try {

      const enabled =
        !!req.body.enabled;

      const { error } =
        await supabase
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


// =====================================================
// TIMER CREATE
// =====================================================

app.post(
  "/api/timer/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      const minutes =
        Number(req.body.minutes);

      const targetState =
        !!req.body.state;


      if (
        ![0, 1, 2, 3].includes(id)
      ) {
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
          error:
            "Minutes must be between 1 and 10080"
        });
      }


      // Only one active timer
      // per appliance.
      await supabase
        .from("timers")
        .update({
          active: false
        })
        .eq("appliance_id", id)
        .eq("active", true);


      const executeAt =
        new Date(
          Date.now() +
          minutes * 60 * 1000
        ).toISOString();


      const {
        data,
        error
      } = await supabase
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


      // Room Light timer disables Auto.
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


// =====================================================
// TIMER CANCEL
// =====================================================

app.delete(
  "/api/timer/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      const { error } =
        await supabase
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
        error:
          "Timer cancellation failed"
      });
    }
  }
);


// =====================================================
// ERASE RUNTIME
// =====================================================

app.post(
  "/api/erase/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      if (
        ![0, 1, 2, 3].includes(id)
      ) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }


      const {
        data: reset,
        error: resetError
      } = await supabase
        .from("runtime_resets")
        .insert({
          appliance_id: id
        })
        .select()
        .single();


      if (resetError) {
        return res.status(500).json({
          error:
            resetError.message
        });
      }


      const { error } =
        await supabase
          .from("appliances")
          .update({
            runtime_seconds: 0,

            history_baseline_runtime_seconds:
              0
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


// =====================================================
// LOAD SETTINGS
// =====================================================

app.post(
  "/api/load/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      const watts =
        Number(req.body.watts);


      if (
        ![0, 1, 2, 3].includes(id)
      ) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }


      if (
        !Number.isFinite(watts) ||
        watts < 0 ||
        watts > 10000
      ) {
        return res.status(400).json({
          error:
            "Watt value must be between 0 and 10000"
        });
      }


      const { error } =
        await supabase
          .from("appliances")
          .update({
            power_w: watts
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
        powerW: watts
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: "Load setting failed"
      });
    }
  }
);


// =====================================================
// HISTORY
// =====================================================

app.get(
  "/api/history/:id",
  adminAuth,
  async (req, res) => {

    try {

      const id =
        Number(req.params.id);

      const period =
        req.query.period || "month";


      if (
        ![0, 1, 2, 3].includes(id)
      ) {
        return res.status(400).json({
          error: "Invalid appliance ID"
        });
      }


      if (
        ![
          "today",
          "month",
          "year"
        ].includes(period)
      ) {
        return res.status(400).json({
          error: "Invalid history period"
        });
      }


      const now = new Date();

      let startDate;


      if (period === "today") {

        startDate =
          now.toISOString()
            .slice(0, 10);

      } else if (period === "month") {

        startDate =
          new Date(
            now.getFullYear(),
            now.getMonth(),
            1
          )
            .toISOString()
            .slice(0, 10);

      } else {

        startDate =
          new Date(
            now.getFullYear(),
            0,
            1
          )
            .toISOString()
            .slice(0, 10);
      }


      const {
        data,
        error
      } = await supabase
        .from("energy_history")
        .select(
          "usage_date,runtime_seconds,energy_wh"
        )
        .eq("appliance_id", id)
        .gte("usage_date", startDate)
        .order("usage_date", {
          ascending: true
        });


      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }


      // Monthly/yearly totals are calculated
      // from the stored daily records.
      let totalRuntime = 0;
      let totalEnergy = 0;

      for (
        const row of data || []
      ) {

        totalRuntime +=
          Number(
            row.runtime_seconds || 0
          );

        totalEnergy +=
          Number(
            row.energy_wh || 0
          );
      }


      res.json({
        ok: true,
        appliance: id,
        period,
        rows: data || [],
        totalRuntimeSeconds:
          totalRuntime,
        totalEnergyWh:
          totalEnergy
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error: "History failed"
      });
    }
  }
);


// =====================================================
// CHANGE DASHBOARD ACCESS CODE
// =====================================================

app.post(
  "/api/change-access-code",
  adminAuth,
  async (req, res) => {

    try {

      const newCode =
        String(
          req.body.newCode || ""
        ).trim();


      if (newCode.length < 6) {
        return res.status(400).json({
          error:
            "New access code must contain at least 6 characters."
        });
      }


      const newSalt =
        crypto
          .randomBytes(16)
          .toString("hex");

      const newHash =
        hashCode(
          newCode,
          newSalt
        );


      const {
        error
      } = await supabase
        .from("dashboard_auth")
        .update({
          code_hash: newHash,
          code_salt: newSalt,
          updated_at:
            new Date().toISOString()
        })
        .eq("id", 1);


      if (error) {
        return res.status(500).json({
          error: error.message
        });
      }


      // Update memory immediately.
      dashboardCodeHash =
        newHash;

      dashboardCodeSalt =
        newSalt;


      res.json({
        ok: true,
        message:
          "Dashboard access code changed successfully."
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Access code change failed"
      });
    }
  }
);


// =====================================================
// STATIC WEBSITE
// =====================================================

app.use(
  express.static("public")
);


app.get("/", (req, res) => {

  res.sendFile(
    __dirname +
    "/public/index.html"
  );
});


// =====================================================
// START SERVER
// =====================================================

async function startServer() {

  try {

    await initializeDashboardAuth();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `EcoSmart Home server running on port ${PORT}`
        );
      }
    );

  } catch (err) {

    console.error(
      "Server startup failed:",
      err
    );

    process.exit(1);
  }
}

startServer();
