const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;


// =====================================================
// GOOGLE HOME CONFIGURATION
// =====================================================

const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID;

const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET;

const GOOGLE_LINK_CODE =
  process.env.GOOGLE_LINK_CODE;

const GOOGLE_PROJECT_ID =
  "ecosmart-home-0f242";

const GOOGLE_REDIRECT_URI =
  `https://oauth-redirect.googleusercontent.com/r/${GOOGLE_PROJECT_ID}`;


// Google Home uses this single user for this prototype.
const GOOGLE_AGENT_USER_ID =
  "ecosmart-primary-user";


// =====================================================
// BASIC ENVIRONMENT CHECK
// =====================================================

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing Supabase environment variables."
  );

  process.exit(1);
}

if (!DEVICE_TOKEN) {
  console.error(
    "Missing DEVICE_TOKEN environment variable."
  );

  process.exit(1);
}


// Google variables are checked later.
// This prevents the existing dashboard from
// becoming completely unusable if Google settings
// are temporarily missing.
if (!GOOGLE_OAUTH_CLIENT_ID) {
  console.warn(
    "WARNING: GOOGLE_OAUTH_CLIENT_ID is not set."
  );
}

if (!GOOGLE_OAUTH_CLIENT_SECRET) {
  console.warn(
    "WARNING: GOOGLE_OAUTH_CLIENT_SECRET is not set."
  );
}

if (!GOOGLE_LINK_CODE) {
  console.warn(
    "WARNING: GOOGLE_LINK_CODE is not set."
  );
}


// =====================================================
// SUPABASE
// =====================================================

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

  if (
    !dashboardCodeHash ||
    !dashboardCodeSalt
  ) {
    return false;
  }

  try {

    const calculated =
      hashCode(
        code,
        dashboardCodeSalt
      );

    return crypto.timingSafeEqual(
      Buffer.from(
        calculated,
        "hex"
      ),
      Buffer.from(
        dashboardCodeHash,
        "hex"
      )
    );

  } catch {

    return false;
  }
}


async function initializeDashboardAuth() {

  const {
    data,
    error
  } = await supabase
    .from("dashboard_auth")
    .select(
      "code_hash, code_salt"
    )
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
  // Render ADMIN_TOKEN becomes
  // the initial dashboard code.
  if (!data) {

    if (!ADMIN_TOKEN) {

      console.error(
        "ADMIN_TOKEN is required for first dashboard setup."
      );

      process.exit(1);
    }


    const salt =
      crypto
        .randomBytes(16)
        .toString("hex");

    const hash =
      hashCode(
        ADMIN_TOKEN,
        salt
      );


    const {
      error: insertError
    } = await supabase
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


    dashboardCodeHash =
      hash;

    dashboardCodeSalt =
      salt;


    console.log(
      "Dashboard access code initialized from ADMIN_TOKEN."
    );

    return;
  }


  dashboardCodeHash =
    data.code_hash;

  dashboardCodeSalt =
    data.code_salt;


  console.log(
    "Dashboard access code loaded."
  );
}


// =====================================================
// AUTHENTICATION
// =====================================================

function adminAuth(
  req,
  res,
  next
) {

  const token =
    req.headers["x-admin-token"];


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


function deviceAuth(
  req,
  res,
  next
) {

  const token =
    req.headers["x-device-token"];


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

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      service:
        "EcoSmart Home Cloud API",
      time:
        new Date().toISOString()
    });
  }
);


// =====================================================
// TIMER PROCESSING
// =====================================================

async function processTimers() {

  const now =
    new Date().toISOString();


  const {
    data: timers,
    error
  } = await supabase
    .from("timers")
    .select("*")
    .eq("active", true)
    .lte("execute_at", now)
    .order(
      "execute_at",
      {
        ascending: true
      }
    );


  if (error) {

    console.error(
      "Timer query error:",
      error.message
    );

    return;
  }


  if (
    !timers ||
    timers.length === 0
  ) {
    return;
  }


  for (
    const timer
    of timers
  ) {

    const {
      error: updateError
    } = await supabase
      .from("appliances")
      .update({
        desired_state:
          timer.target_state
      })
      .eq(
        "id",
        timer.appliance_id
      );


    if (updateError) {

      console.error(
        "Timer appliance update error:",
        updateError.message
      );

      continue;
    }


    // Room Light timer disables
    // automatic mode.
    if (
      timer.appliance_id === 0
    ) {

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
      .eq(
        "id",
        timer.id
      );
  }
}


// =====================================================
// ENERGY HISTORY
// =====================================================

async function recordEnergyUsage(
  applianceId,
  currentRuntime
) {

  const now =
    new Date();

  const today =
    now.toISOString()
      .slice(0, 10);


  const {
    data: appliance,
    error
  } = await supabase
    .from("appliances")
    .select(
      "power_w,history_date,history_baseline_runtime_seconds,history_initialized"
    )
    .eq(
      "id",
      applianceId
    )
    .single();


  if (
    error ||
    !appliance
  ) {
    return;
  }


  const runtime =
    Math.max(
      0,
      Number(
        currentRuntime || 0
      )
    );


  const powerW =
    appliance.power_w === null ||
    appliance.power_w === undefined
      ? 0
      : Number(
          appliance.power_w
        );


  // First report after this
  // feature is installed.
  if (
    !appliance.history_initialized
  ) {

    await supabase
      .from("appliances")
      .update({
        history_date:
          today,

        history_baseline_runtime_seconds:
          runtime,

        history_initialized:
          true
      })
      .eq(
        "id",
        applianceId
      );

    return;
  }


  const oldRuntime =
    Math.max(
      0,
      Number(
        appliance
          .history_baseline_runtime_seconds ||
        0
      )
    );


  // Runtime became smaller:
  // probably Erase Time / ESP reset.
  if (
    runtime < oldRuntime
  ) {

    await supabase
      .from("appliances")
      .update({
        history_date:
          today,

        history_baseline_runtime_seconds:
          runtime,

        history_initialized:
          true
      })
      .eq(
        "id",
        applianceId
      );

    return;
  }


  const deltaSeconds =
    runtime - oldRuntime;


  // No new runtime.
  if (
    deltaSeconds <= 0
  ) {

    await supabase
      .from("appliances")
      .update({
        history_date:
          today,

        history_baseline_runtime_seconds:
          runtime
      })
      .eq(
        "id",
        applianceId
      );

    return;
  }


  /*
    Estimated energy:

    Energy (Wh)
    =
    Power (W) × Runtime (hours)
  */

  const energyWh =
    (deltaSeconds / 3600) *
    powerW;


  const historyDate =
    today;


  const {
    data: existing
  } = await supabase
    .from("energy_history")
    .select(
      "runtime_seconds,energy_wh"
    )
    .eq(
      "appliance_id",
      applianceId
    )
    .eq(
      "usage_date",
      historyDate
    )
    .maybeSingle();


  if (existing) {

    const newRuntime =
      Number(
        existing.runtime_seconds || 0
      ) +
      deltaSeconds;


    const newEnergy =
      Number(
        existing.energy_wh || 0
      ) +
      energyWh;


    await supabase
      .from("energy_history")
      .update({

        runtime_seconds:
          newRuntime,

        energy_wh:
          newEnergy,

        updated_at:
          new Date().toISOString()
      })
      .eq(
        "appliance_id",
        applianceId
      )
      .eq(
        "usage_date",
        historyDate
      );

  } else {

    await supabase
      .from("energy_history")
      .insert({

        appliance_id:
          applianceId,

        usage_date:
          historyDate,

        runtime_seconds:
          deltaSeconds,

        energy_wh:
          energyWh
      });
  }


  await supabase
    .from("appliances")
    .update({

      history_date:
        today,

      history_baseline_runtime_seconds:
        runtime,

      history_initialized:
        true,

      energy_wh:
        energyWh
    })
    .eq(
      "id",
      applianceId
    );
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


      const {
        data: appliances,
        error
      } = await supabase
        .from("appliances")
        .select(
          "id,name,desired_state,reported_state,runtime_seconds"
        )
        .order(
          "id",
          {
            ascending: true
          }
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
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
          error:
            settingsError.message
        });
      }


      const resetIds = {};


      for (
        const appliance
        of appliances || []
      ) {

        const {
          data: resetData
        } = await supabase
          .from("runtime_resets")
          .select("id")
          .eq(
            "appliance_id",
            appliance.id
          )
          .order(
            "id",
            {
              ascending: false
            }
          )
          .limit(1);


        resetIds[
          appliance.id
        ] =
          resetData &&
          resetData.length
            ? resetData[0].id
            : 0;
      }


      res.json({

        ok: true,

        states:
          (
            appliances || []
          ).map(a => ({

            id:
              a.id,

            state:
              !!a.desired_state

          })),

        roomAuto:
          !!settings.room_auto,

        resetIds
      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Server error"
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

      const body =
        req.body || {};


      const states =
        Array.isArray(
          body.states
        )
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

      for (
        let id = 0;
        id < 4;
        id++
      ) {

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


        const {
          error:
            applianceUpdateError
        } = await supabase
          .from("appliances")
          .update({

            reported_state:
              state,

            runtime_seconds:
              runtime,

            last_seen:
              new Date().toISOString(),

            online:
              true
          })
          .eq(
            "id",
            id
          );


        if (
          applianceUpdateError
        ) {

          console.error(
            `Appliance ${id} report update error:`,
            applianceUpdateError.message
          );
        }


        // Record estimated energy.
        await recordEnergyUsage(
          id,
          runtime
        );
      }


      // -----------------------------------------
      // Physical switch changes
      // -----------------------------------------

      const manualChanges =
        Array.isArray(
          body.manualChanges
        )
          ? body.manualChanges
          : [];


      for (
        const change
        of manualChanges
      ) {

        const id =
          Number(
            change.id
          );


        if (
          ![
            0,
            1,
            2,
            3
          ].includes(id)
        ) {
          continue;
        }


        const state =
          change.state === true ||
          change.state === 1;


        const {
          error:
            manualUpdateError
        } = await supabase
          .from("appliances")
          .update({
            desired_state:
              state
          })
          .eq(
            "id",
            id
          );


        if (
          manualUpdateError
        ) {

          console.error(
            `Manual change update error for appliance ${id}:`,
            manualUpdateError.message
          );
        }


        // Physical Room Light switch
        // disables automatic mode.
        if (
          id === 0
        ) {

          const {
            error:
              autoDisableError
          } = await supabase
            .from("settings")
            .update({
              room_auto:
                false
            })
            .eq(
              "id",
              1
            );


          if (
            autoDisableError
          ) {

            console.error(
              "Room auto disable error:",
              autoDisableError.message
            );
          }
        }
      }


      // -----------------------------------------
      // Device status
      // -----------------------------------------

      const {
        error:
          deviceUpdateError
      } = await supabase
        .from("devices")
        .update({

          last_seen:
            new Date().toISOString(),

          online:
            true,

          ldr_value:
            ldr,

          uptime_seconds:
            uptime
        })
        .eq(
          "id",
          1
        );


      if (
        deviceUpdateError
      ) {

        console.error(
          "Device status update error:",
          deviceUpdateError.message
        );
      }


      // -----------------------------------------
      // Room Auto state from ESP
      // -----------------------------------------

      if (
        typeof body.roomAuto ===
        "boolean"
      ) {

        const {
          error:
            roomAutoError
        } = await supabase
          .from("settings")
          .update({

            room_auto:
              body.roomAuto

          })
          .eq(
            "id",
            1
          );


        if (
          roomAutoError
        ) {

          console.error(
            "Room auto state update error:",
            roomAutoError.message
          );
        }
      }


      // =================================================
      // ROOM LIGHT LDR AUTO STATE -> DESIRED STATE
      // =================================================

      if (
        body.roomAuto === true &&
        body.roomAutoState !==
          undefined
      ) {

        const roomAutoState =
          body.roomAutoState ===
            true ||
          body.roomAutoState ===
            1;


        const {
          error:
            roomAutoStateError
        } = await supabase
          .from("appliances")
          .update({

            desired_state:
              roomAutoState

          })
          .eq(
            "id",
            0
          );


        if (
          roomAutoStateError
        ) {

          console.error(
            "Room Auto desired state update error:",
            roomAutoStateError.message
          );
        }
      }


      res.json({

        ok: true,

        received:
          true

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Report failed"
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
        .order(
          "id",
          {
            ascending: true
          }
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      const {
        data: settings
      } = await supabase
        .from("settings")
        .select("*")
        .eq(
          "id",
          1
        )
        .single();


      const {
        data: timers
      } = await supabase
        .from("timers")
        .select("*")
        .eq(
          "active",
          true
        )
        .order(
          "execute_at",
          {
            ascending: true
          }
        );


      const {
        data: device
      } = await supabase
        .from("devices")
        .select("*")
        .eq(
          "id",
          1
        )
        .single();


      // Today's energy
      const today =
        new Date()
          .toISOString()
          .slice(
            0,
            10
          );


      const {
        data: todayHistory
      } = await supabase
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

        todayEnergy[
          row.appliance_id
        ] =
          Number(
            row.energy_wh || 0
          );
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
        error:
          "Dashboard error"
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
        Number(
          req.params.id
        );


      if (
        ![
          0,
          1,
          2,
          3
        ].includes(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid appliance ID"
        });
      }


      const state =
        !!req.body.state;


      const {
        error
      } = await supabase
        .from("appliances")
        .update({

          desired_state:
            state

        })
        .eq(
          "id",
          id
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      // Manual Room Light control
      // disables Auto Mode.
      if (
        id === 0
      ) {

        await supabase
          .from("settings")
          .update({
            room_auto:
              false
          })
          .eq(
            "id",
            1
          );
      }


      res.json({

        ok: true,

        appliance:
          id,

        state:
          state

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Control failed"
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


      const {
        error
      } = await supabase
        .from("settings")
        .update({

          room_auto:
            enabled

        })
        .eq(
          "id",
          1
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      res.json({

        ok: true,

        roomAuto:
          enabled

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Room auto update failed"
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
        Number(
          req.params.id
        );


      const minutes =
        Number(
          req.body.minutes
        );


      const targetState =
        !!req.body.state;


      if (
        ![
          0,
          1,
          2,
          3
        ].includes(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid appliance ID"
        });
      }


      if (
        !Number.isFinite(
          minutes
        ) ||
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
          active:
            false
        })
        .eq(
          "appliance_id",
          id
        )
        .eq(
          "active",
          true
        );


      const executeAt =
        new Date(
          Date.now() +
          minutes *
            60 *
            1000
        ).toISOString();


      const {
        data,
        error
      } = await supabase
        .from("timers")
        .insert({

          appliance_id:
            id,

          target_state:
            targetState,

          execute_at:
            executeAt,

          active:
            true

        })
        .select()
        .single();


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      // Room Light timer disables Auto.
      if (
        id === 0
      ) {

        await supabase
          .from("settings")
          .update({
            room_auto:
              false
          })
          .eq(
            "id",
            1
          );
      }


      res.json({

        ok: true,

        timer:
          data

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Timer creation failed"
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
        Number(
          req.params.id
        );


      const {
        error
      } = await supabase
        .from("timers")
        .update({
          active:
            false
        })
        .eq(
          "id",
          id
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      res.json({

        ok: true,

        cancelled:
          id

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
        Number(
          req.params.id
        );


      if (
        ![
          0,
          1,
          2,
          3
        ].includes(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid appliance ID"
        });
      }


      const {
        data: reset,
        error:
          resetError
      } = await supabase
        .from("runtime_resets")
        .insert({

          appliance_id:
            id

        })
        .select()
        .single();


      if (resetError) {

        return res.status(500).json({
          error:
            resetError.message
        });
      }


      const {
        error
      } = await supabase
        .from("appliances")
        .update({

          runtime_seconds:
            0,

          history_baseline_runtime_seconds:
            0

        })
        .eq(
          "id",
          id
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      res.json({

        ok: true,

        appliance:
          id,

        resetId:
          reset.id

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Runtime reset failed"
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
        Number(
          req.params.id
        );


      const watts =
        Number(
          req.body.watts
        );


      if (
        ![
          0,
          1,
          2,
          3
        ].includes(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid appliance ID"
        });
      }


      if (
        !Number.isFinite(
          watts
        ) ||
        watts < 0 ||
        watts > 10000
      ) {

        return res.status(400).json({
          error:
            "Watt value must be between 0 and 10000"
        });
      }


      const {
        error
      } = await supabase
        .from("appliances")
        .update({

          power_w:
            watts

        })
        .eq(
          "id",
          id
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      res.json({

        ok: true,

        appliance:
          id,

        powerW:
          watts

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "Load setting failed"
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
        Number(
          req.params.id
        );


      const period =
        req.query.period ||
        "month";


      if (
        ![
          0,
          1,
          2,
          3
        ].includes(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid appliance ID"
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
          error:
            "Invalid history period"
        });
      }


      const now =
        new Date();

      let startDate;


      if (
        period === "today"
      ) {

        startDate =
          now.toISOString()
            .slice(
              0,
              10
            );

      } else if (
        period === "month"
      ) {

        startDate =
          new Date(
            now.getFullYear(),
            now.getMonth(),
            1
          )
            .toISOString()
            .slice(
              0,
              10
            );

      } else {

        startDate =
          new Date(
            now.getFullYear(),
            0,
            1
          )
            .toISOString()
            .slice(
              0,
              10
            );
      }


      const {
        data,
        error
      } = await supabase
        .from("energy_history")
        .select(
          "usage_date,runtime_seconds,energy_wh"
        )
        .eq(
          "appliance_id",
          id
        )
        .gte(
          "usage_date",
          startDate
        )
        .order(
          "usage_date",
          {
            ascending:
              true
          }
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


      let totalRuntime =
        0;

      let totalEnergy =
        0;


      for (
        const row
        of data || []
      ) {

        totalRuntime +=
          Number(
            row.runtime_seconds ||
            0
          );


        totalEnergy +=
          Number(
            row.energy_wh ||
            0
          );
      }


      res.json({

        ok: true,

        appliance:
          id,

        period:
          period,

        rows:
          data || [],

        totalRuntimeSeconds:
          totalRuntime,

        totalEnergyWh:
          totalEnergy

      });

    } catch (err) {

      console.error(err);

      res.status(500).json({
        error:
          "History failed"
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
          req.body.newCode ||
          ""
        ).trim();


      if (
        newCode.length < 6
      ) {

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

          code_hash:
            newHash,

          code_salt:
            newSalt,

          updated_at:
            new Date().toISOString()

        })
        .eq(
          "id",
          1
        );


      if (error) {

        return res.status(500).json({
          error:
            error.message
        });
      }


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
// GOOGLE HOME
// OAUTH + SMART HOME FULFILLMENT
// =====================================================
//
// Flow:
//
// Google Home
//      ↓
// /oauth/authorize
//      ↓
// User enters GOOGLE_LINK_CODE
//      ↓
// Google receives authorization code
//      ↓
// /oauth/token
//      ↓
// Google gets access token
//      ↓
// /google/fulfillment
//      ↓
// SYNC / QUERY / EXECUTE
//      ↓
// Supabase
//      ↓
// ESP8266
//
// =====================================================


// -----------------------------------------------------
// Temporary OAuth storage
// -----------------------------------------------------
//
// This is suitable for a prototype / single-user
// demonstration.
//
// IMPORTANT:
// Render restart/sleep can clear these Maps.
// If that happens, Google may require account
// linking again.
// -----------------------------------------------------

const googleAuthCodes =
  new Map();

const googleAccessTokens =
  new Map();

const googleRefreshTokens =
  new Map();


// -----------------------------------------------------
// HTML escaping
// -----------------------------------------------------

function escapeHtml(value) {

  return String(
    value || ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


// -----------------------------------------------------
// Random token
// -----------------------------------------------------

function randomToken(
  bytes = 32
) {

  return crypto
    .randomBytes(bytes)
    .toString("hex");
}


// -----------------------------------------------------
// OAuth configuration check
// -----------------------------------------------------

function googleConfigAvailable() {

  return !!(
    GOOGLE_OAUTH_CLIENT_ID &&
    GOOGLE_OAUTH_CLIENT_SECRET &&
    GOOGLE_LINK_CODE
  );
}


// =====================================================
// GOOGLE OAUTH AUTHORIZE - GET
// =====================================================

app.get(
  "/oauth/authorize",
  (req, res) => {

    const {
      client_id,
      redirect_uri,
      response_type,
      state,
      code_challenge,
      code_challenge_method
    } = req.query;


    if (
      !googleConfigAvailable()
    ) {

      return res.status(503).send(
        "Google OAuth is not configured on the server."
      );
    }


    if (
      client_id !==
      GOOGLE_OAUTH_CLIENT_ID
    ) {

      return res.status(400).send(
        "Invalid OAuth client_id."
      );
    }


    if (
      redirect_uri !==
      GOOGLE_REDIRECT_URI
    ) {

      return res.status(400).send(
        "Invalid redirect_uri."
      );
    }


    if (
      response_type !== "code"
    ) {

      return res.status(400).send(
        "Invalid response_type."
      );
    }


    if (
      code_challenge_method &&
      code_challenge_method !==
        "S256"
    ) {

      return res.status(400).send(
        "Only S256 PKCE is supported."
      );
    }


    const safeState =
      escapeHtml(
        state || ""
      );

    const safeClientId =
      escapeHtml(
        client_id || ""
      );

    const safeRedirect =
      escapeHtml(
        redirect_uri || ""
      );

    const safeChallenge =
      escapeHtml(
        code_challenge || ""
      );


    res.send(`
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>EcoSmart Home</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
  font-family:Arial,sans-serif;
  background:#f2f4f7;
  color:#222;
}

.card{
  width:100%;
  max-width:420px;
  background:white;
  border-radius:18px;
  padding:28px;
  box-shadow:0 8px 30px rgba(0,0,0,.10);
}

h1{
  margin:0 0 10px;
  font-size:26px;
}

p{
  line-height:1.5;
  color:#555;
}

label{
  display:block;
  margin-top:18px;
  margin-bottom:7px;
  font-weight:600;
}

input{
  width:100%;
  padding:13px;
  border:1px solid #ccc;
  border-radius:10px;
  font-size:16px;
}

button{
  width:100%;
  margin-top:20px;
  padding:14px;
  border:0;
  border-radius:10px;
  background:#111;
  color:white;
  font-size:16px;
  cursor:pointer;
}

.small{
  font-size:13px;
  color:#777;
  margin-top:14px;
}

</style>

</head>

<body>

<div class="card">

<h1>EcoSmart Home</h1>

<p>
Sign in to link your EcoSmart Home
devices with Google.
</p>

<p>
By signing in, you are authorizing
Google to control your devices.
</p>

<form method="POST" action="/oauth/authorize">

<input
  type="hidden"
  name="client_id"
  value="${safeClientId}"
>

<input
  type="hidden"
  name="redirect_uri"
  value="${safeRedirect}"
>

<input
  type="hidden"
  name="response_type"
  value="code"
>

<input
  type="hidden"
  name="state"
  value="${safeState}"
>

<input
  type="hidden"
  name="code_challenge"
  value="${safeChallenge}"
>

<input
  type="hidden"
  name="code_challenge_method"
  value="S256"
>

<label>
EcoSmart Home Access Code
</label>

<input
  type="password"
  name="link_code"
  required
  autocomplete="current-password"
>

<button type="submit">
Link Google
</button>

</form>

<div class="small">
This code is the private Google linking
code configured by the EcoSmart Home owner.
</div>

</div>

</body>

</html>
    `);
  }
);


// =====================================================
// GOOGLE OAUTH AUTHORIZE - POST
// =====================================================

app.post(
  "/oauth/authorize",
  (req, res) => {

    const {
      client_id,
      redirect_uri,
      response_type,
      state,
      link_code,
      code_challenge,
      code_challenge_method
    } = req.body;


    if (
      !googleConfigAvailable()
    ) {

      return res.status(503).send(
        "Google OAuth is not configured on the server."
      );
    }


    if (
      client_id !==
      GOOGLE_OAUTH_CLIENT_ID
    ) {

      return res.status(400).send(
        "Invalid OAuth client_id."
      );
    }


    if (
      redirect_uri !==
      GOOGLE_REDIRECT_URI
    ) {

      return res.status(400).send(
        "Invalid redirect_uri."
      );
    }


    if (
      response_type !==
      "code"
    ) {

      return res.status(400).send(
        "Invalid response_type."
      );
    }


    if (
      String(link_code || "") !==
      String(GOOGLE_LINK_CODE)
    ) {

      return res.status(401).send(`
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>EcoSmart Home</title>

</head>

<body
  style="
    font-family:Arial;
    padding:40px;
    text-align:center;
  "
>

<h2>Invalid access code</h2>

<p>
Please go back and enter the correct
EcoSmart Home access code.
</p>

</body>

</html>
      `);
    }


    if (
      code_challenge_method &&
      code_challenge_method !==
        "S256"
    ) {

      return res.status(400).send(
        "Unsupported PKCE method."
      );
    }


    const authorizationCode =
      randomToken(32);


    googleAuthCodes.set(
      authorizationCode,
      {

        clientId:
          client_id,

        redirectUri:
          redirect_uri,

        codeChallenge:
          code_challenge || null,

        codeChallengeMethod:
          code_challenge_method ||
          null,

        createdAt:
          Date.now(),

        used:
          false
      }
    );


    // Authorization code expires
    // after 10 minutes.
    setTimeout(
      () => {

        googleAuthCodes.delete(
          authorizationCode
        );

      },
      10 * 60 * 1000
    );


    const redirect =
      new URL(
        redirect_uri
      );


    redirect.searchParams.set(
      "code",
      authorizationCode
    );


    if (state) {

      redirect.searchParams.set(
        "state",
        state
      );
    }


    res.redirect(
      redirect.toString()
    );
  }
);


// =====================================================
// GOOGLE OAUTH TOKEN
// =====================================================

app.post(
  "/oauth/token",
  (req, res) => {

    if (
      !googleConfigAvailable()
    ) {

      return res.status(503).json({
        error:
          "server_error"
      });
    }


    let clientId =
      req.body.client_id;

    let clientSecret =
      req.body.client_secret;


    // Support HTTP Basic Authentication.
    const authorization =
      req.headers.authorization;


    if (
      authorization &&
      authorization.startsWith(
        "Basic "
      )
    ) {

      try {

        const decoded =
          Buffer.from(
            authorization.slice(6),
            "base64"
          ).toString("utf8");


        const separator =
          decoded.indexOf(":");


        if (
          separator !== -1
        ) {

          clientId =
            decodeURIComponent(
              decoded.slice(
                0,
                separator
              )
            );

          clientSecret =
            decodeURIComponent(
              decoded.slice(
                separator + 1
              )
            );
        }

      } catch {

        return res.status(401).json({
          error:
            "invalid_client"
        });
      }
    }


    if (
      clientId !==
      GOOGLE_OAUTH_CLIENT_ID ||
      clientSecret !==
      GOOGLE_OAUTH_CLIENT_SECRET
    ) {

      return res.status(401).json({
        error:
          "invalid_client"
      });
    }


    const grantType =
      req.body.grant_type;


    // -------------------------------------------------
    // AUTHORIZATION CODE
    // -------------------------------------------------

    if (
      grantType ===
      "authorization_code"
    ) {

      const code =
        req.body.code;


      const record =
        googleAuthCodes.get(
          code
        );


      if (
        !record ||
        record.used
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }


      if (
        Date.now() -
        record.createdAt >
        10 * 60 * 1000
      ) {

        googleAuthCodes.delete(
          code
        );

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }


      if (
        record.clientId !==
        clientId
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }


      if (
        record.redirectUri !==
        req.body.redirect_uri
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }


      // -------------------------------------------------
      // PKCE verification
      // -------------------------------------------------

      if (
        record.codeChallenge
      ) {

        const verifier =
          req.body.code_verifier;


        if (!verifier) {

          return res.status(400).json({
            error:
              "invalid_grant"
          });
        }


        const calculatedChallenge =
          crypto
            .createHash("sha256")
            .update(
              verifier
            )
            .digest("base64")
            .replace(
              /\+/g,
              "-"
            )
            .replace(
              /\//g,
              "_"
            )
            .replace(
              /=+$/,
              ""
            );


        if (
          calculatedChallenge !==
          record.codeChallenge
        ) {

          return res.status(400).json({
            error:
              "invalid_grant"
          });
        }
      }


      record.used =
        true;


      const accessToken =
        randomToken(32);

      const refreshToken =
        randomToken(32);


      googleAccessTokens.set(
        accessToken,
        {

          userId:
            GOOGLE_AGENT_USER_ID,

          createdAt:
            Date.now()

        }
      );


      googleRefreshTokens.set(
        refreshToken,
        {

          userId:
            GOOGLE_AGENT_USER_ID,

          createdAt:
            Date.now()

        }
      );


      return res.json({

        token_type:
          "Bearer",

        access_token:
          accessToken,

        refresh_token:
          refreshToken,

        expires_in:
          3600

      });
    }


    // -------------------------------------------------
    // REFRESH TOKEN
    // -------------------------------------------------

    if (
      grantType ===
      "refresh_token"
    ) {

      const refreshToken =
        req.body.refresh_token;


      const refreshRecord =
        googleRefreshTokens.get(
          refreshToken
        );


      if (
        !refreshRecord
      ) {

        return res.status(400).json({
          error:
            "invalid_grant"
        });
      }


      const newAccessToken =
        randomToken(32);


      googleAccessTokens.set(
        newAccessToken,
        {

          userId:
            refreshRecord.userId,

          createdAt:
            Date.now()

        }
      );


      return res.json({

        token_type:
          "Bearer",

        access_token:
          newAccessToken,

        expires_in:
          3600

      });
    }


    return res.status(400).json({
      error:
        "unsupported_grant_type"
    });
  }
);


// =====================================================
// GOOGLE ACCESS TOKEN CHECK
// =====================================================

function getGoogleUser(req) {

  const authorization =
    req.headers.authorization;


  if (
    !authorization ||
    !authorization.startsWith(
      "Bearer "
    )
  ) {

    return null;
  }


  const token =
    authorization.slice(7).trim();


  if (!token) {
    return null;
  }


  const record =
    googleAccessTokens.get(
      token
    );


  if (!record) {
    return null;
  }


  // Access token = 1 hour.
  if (
    Date.now() -
    record.createdAt >
    60 * 60 * 1000
  ) {

    googleAccessTokens.delete(
      token
    );

    return null;
  }


  return record.userId;
}


// =====================================================
// GOOGLE HOME DEVICE DEFINITIONS
// =====================================================

function googleDevices() {

  return [

    {
      id:
        "0",

      type:
        "action.devices.types.LIGHT",

      traits:
        [
          "action.devices.traits.OnOff"
        ],

      name: {

        name:
          "Room Light"

      },

      willReportState:
        false
    },


    {
      id:
        "1",

      type:
        "action.devices.types.LIGHT",

      traits:
        [
          "action.devices.traits.OnOff"
        ],

      name: {

        name:
          "Night Light"

      },

      willReportState:
        false
    },


    {
      id:
        "2",

      type:
        "action.devices.types.FAN",

      traits:
        [
          "action.devices.traits.OnOff"
        ],

      name: {

        name:
          "Fan"

      },

      willReportState:
        false
    },


    {
      id:
        "3",

      type:
        "action.devices.types.LIGHT",

      traits:
        [
          "action.devices.traits.OnOff"
        ],

      name: {

        name:
          "Desk Light"

      },

      willReportState:
        false
    }

  ];
}


// =====================================================
// GOOGLE HOME FULFILLMENT
// =====================================================

app.post(
  "/google/fulfillment",
  async (req, res) => {

    try {

      const userId =
        getGoogleUser(req);


      if (!userId) {

        return res.status(401).json({
          error:
            "Unauthorized"
        });
      }


      const request =
        req.body || {};


      const requestId =
        request.requestId ||
        "unknown";


      const inputs =
        Array.isArray(
          request.inputs
        )
          ? request.inputs
          : [];


      if (
        inputs.length === 0
      ) {

        return res.status(400).json({
          error:
            "No inputs supplied"
        });
      }


      for (
        const input
        of inputs
      ) {

        const intent =
          input.intent;


        // =================================================
        // SYNC
        // =================================================

        if (
          intent ===
          "action.devices.SYNC"
        ) {

          return res.json({

            requestId:

              requestId,

            payload: {

              agentUserId:
                GOOGLE_AGENT_USER_ID,

              devices:
                googleDevices()

            }

          });
        }


        // =================================================
        // QUERY
        // =================================================

        if (
          intent ===
          "action.devices.QUERY"
        ) {

          const devices =
            input.payload &&
            Array.isArray(
              input.payload.devices
            )
              ? input.payload.devices
              : [];


          const deviceIds =
            devices.map(
              d => String(d.id)
            );


          const {
            data: appliances,
            error
          } = await supabase
            .from("appliances")
            .select(
              "id,reported_state,online"
            )
            .in(
              "id",
              deviceIds
            );


          if (error) {

            console.error(
              "Google QUERY error:",
              error.message
            );

            return res.status(500).json({
              error:
                "QUERY failed"
            });
          }


          const states = {};


          for (
            const appliance
            of appliances || []
          ) {

            states[
              String(
                appliance.id
              )
            ] = {

              online:
                appliance.online !==
                false,

              on:
                !!appliance.reported_state

            };
          }


          // If a device was requested but
          // wasn't returned from Supabase,
          // report it offline.
          for (
            const id
            of deviceIds
          ) {

            if (
              !states[id]
            ) {

              states[id] = {

                online:
                  false,

                on:
                  false

              };
            }
          }


          return res.json({

            requestId:

              requestId,

            payload: {

              devices:
                states

            }

          });
        }


        // =================================================
        // EXECUTE
        // =================================================

        if (
          intent ===
          "action.devices.EXECUTE"
        ) {

          const commands =
            input.payload &&
            Array.isArray(
              input.payload.commands
            )
              ? input.payload.commands
              : [];


          const results = [];


          for (
            const command
            of commands
          ) {

            const devices =
              Array.isArray(
                command.devices
              )
                ? command.devices
                : [];


            const execution =
              Array.isArray(
                command.execution
              )
                ? command.execution
                : [];


            for (
              const executionItem
              of execution
            ) {

              if (
                executionItem.command !==
                "action.devices.commands.OnOff"
              ) {

                continue;
              }


              const params =
                executionItem.params ||
                {};


              const targetState =
                params.on === true;


              for (
                const device
                of devices
              ) {

                const id =
                  Number(
                    device.id
                  );


                if (
                  ![
                    0,
                    1,
                    2,
                    3
                  ].includes(id)
                ) {

                  continue;
                }


                const {
                  error
                } = await supabase
                  .from("appliances")
                  .update({

                    desired_state:
                      targetState

                  })
                  .eq(
                    "id",
                    id
                  );


                if (error) {

                  console.error(
                    `Google EXECUTE appliance ${id} error:`,
                    error.message
                  );

                  return res.status(500).json({
                    error:
                      "EXECUTE failed"
                  });
                }


                // Google controlling Room Light
                // disables LDR automatic mode.
                if (
                  id === 0
                ) {

                  const {
                    error:
                      autoDisableError
                  } = await supabase
                    .from("settings")
                    .update({

                      room_auto:
                        false

                    })
                    .eq(
                      "id",
                      1
                    );


                  if (
                    autoDisableError
                  ) {

                    console.error(
                      "Google Room Auto disable error:",
                      autoDisableError.message
                    );
                  }
                }


                results.push({

                  ids: [
                    String(id)
                  ],

                  status:
                    "SUCCESS",

                  states: {

                    online:
                      true,

                    on:
                      targetState

                  }

                });
              }
            }
          }


          return res.json({

            requestId:

              requestId,

            payload: {

              commands:
                results

            }

          });
        }


        // =================================================
        // DISCONNECT
        // =================================================

        if (
          intent ===
          "action.devices.DISCONNECT"
        ) {

          return res.json({

            requestId:
              requestId,

            payload: {}

          });
        }
      }


      return res.status(400).json({

        error:
          "Unsupported Google Home intent"

      });

    } catch (err) {

      console.error(
        "Google fulfillment error:",
        err
      );

      return res.status(500).json({
        error:
          "Google fulfillment failed"
      });
    }
  }
);


// =====================================================
// STATIC WEBSITE
// =====================================================

app.use(
  express.static(
    "public"
  )
);


app.get(
  "/",
  (req, res) => {

    res.sendFile(
      __dirname +
      "/public/index.html"
    );
  }
);


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

        console.log(
          "Google Home project:",
          GOOGLE_PROJECT_ID
        );

        console.log(
          "Google OAuth redirect URI:",
          GOOGLE_REDIRECT_URI
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
