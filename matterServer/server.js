const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.post("/commission-device", (req, res) => {
    const { node_id, pin_code, discriminator, operational_dataset } = req.body;

    if (!node_id || !pin_code || !discriminator || !operational_dataset) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const command = `./chip-tool pairing ble-thread ${node_id} ${operational_dataset} ${pin_code} ${discriminator}`;
    
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${stderr}`);
            return res.status(500).json({ error: stderr });
        }
        res.json({ message: "Pairing successful", output: stdout });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Matter API Server running on port ${PORT}`);
});
