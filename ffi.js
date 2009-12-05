var FFI = require("./node-ffi");
var sys = require("sys");

exports.Pointer = FFI.Pointer;
exports.StaticFunctions = FFI.StaticFunctions;
exports.Bindings = FFI.Bindings;

FFI.TYPE_TO_POINTER_METHOD_MAP = {
    "byte":     "Byte",
    "int32":    "Int32",
    "sint32":   "Int32", 
    "uint32":   "UInt32", 
    "double":   "Double",
    "string":   "CString", 
    "pointer":  "Pointer"
};

// typedef struct   ffi_cif {
//              ffi_abi     abi;
//              unsigned    nargs;
// /*@dependent@*/  ffi_type**  arg_types;
// /*@dependent@*/  ffi_type*   rtype;
//              unsigned    bytes;
//              unsigned    flags;
// #ifdef FFI_EXTRA_CIF_FIELDS
//              FFI_EXTRA_CIF_FIELDS;
// #endif
// } ffi_cif;

FFI.Bindings.CIF_SIZE = (
    FFI.Bindings.ENUM_SIZE + 
    (FFI.Bindings.POINTER_SIZE * 2) +
    4 * 3
);

exports.buildCif = function(nargs, types, rtype, bytes, flags) {
    var cifPtr = new Pointer(FFI.Bindings.CIF_SIZE);
};

FFI.StructType = function(fields) {
    this._struct = {};
    this._members = [];
    this._size = 0;
    this._alignment = 0;
    
    if (fields) {
        for (var i = 0; i < fields.length; i++) {
            FFI.StructType.prototype.addField.apply(this, fields[i]);
        }
    }
};

// WARNING: This call is going to be unsafe if called after the constructor
FFI.StructType.prototype.addField = function(type, name) {
    // TODO: check to see if name already exists
    var sz = FFI.Bindings.TYPE_SIZE_MAP[type];
    var offset = this._size;
    
    this._size += sz;
    this._alignment = Math.max(this._alignment, sz);
    this._size += Math.abs(this._alignment - sz);
    
    this._struct[name] = { "name": name, "type": type, "size": sz, "offset": offset };
    this._members.push(name);
};

FFI.StructType.prototype.readField = function(ptr, name) {
    var info = this._struct[name];
    var fptr = ptr.seek(info.offset);
    return fptr["get" + FFI.TYPE_TO_POINTER_METHOD_MAP[info.type]]();
};

FFI.StructType.prototype.writeField = function(ptr, name, val) {
    var info = this._struct[name];
    var fptr = ptr.seek(info.offset);
    return fptr["put" + FFI.TYPE_TO_POINTER_METHOD_MAP[info.type]](val);    
};

FFI.StructType.prototype.serialize = function(ptr, data) {
    for (var i = 0; i < this._members.length; i++) {
        var name = this._members[i];
        this.writeField(ptr, name, data[name]);
    }
};

FFI.StructType.prototype.deserialize = function(ptr) {
    var data = {};
    
    for (var i = 0; i < this._members.length; i++) {
        var name = this._members[i];
        data[name] = this.readField(ptr, name);
    }
};

FFI.StructType.prototype.allocate = function(data) {
    var ptr = new FFI.Pointer(this._size);
    
    if (data) {
        this.serialize(ptr, data);
    }
    
    return ptr;
};

FFI.Internal = {};

FFI.Internal.buildCIFArgTypes = function(types) {
    var ptr = new FFI.Pointer(types.length * FFI.Bindings.FFI_TYPE_SIZE);
    var cptr = ptr.seek(0);
    
    for (var i = 0; i < types.length; i++) {
        if (FFI.Bindings.FFI_TYPES[types[i]] == undefined) {
            throw "buildCIFArgTypes: Invalid Type: " + types[i];
        }
        cptr.putPointer(FFI.Bindings.FFI_TYPES[types[i]], true);
    }
    
    return ptr;
};

FFI.Internal.buildCIFArgValues = function(vals) {
    var ptr = new FFI.Pointer(vals.length * FFI.Bindings.POINTER_SIZE);
    var cptr = ptr.seek(0);
    
    for (var i = 0; i < vals.length; i++) {
        cptr.putPointer(vals[i], true);
    }
    
    return ptr;
};

FFI.Internal.bareMethodFactory = function(ptr, returnType, types) {
    var atypes  = FFI.Internal.buildCIFArgTypes(types);
    var rtype   = FFI.Bindings.FFI_TYPES[returnType];
    var cif     = FFI.Bindings.prepCif(types.length, rtype, atypes);
    
    return function(argPtrs) {
        var res     = new FFI.Pointer(FFI.Bindings.TYPE_SIZE_MAP[returnType]);
        var args    = FFI.Internal.buildCIFArgValues(argPtrs);
        
        FFI.Bindings.call(cif, ptr, args, res);
        
        return res;
    };
};

FFI.Internal.buildValue = function(type, val) {
    var ptr = new FFI.Pointer(type == "string" ? val.length + 1 : FFI.Bindings.TYPE_SIZE_MAP[type]);
    ptr["put" + FFI.TYPE_TO_POINTER_METHOD_MAP[type]](val);
    
    if (type == "string") {
        // we have to actually build an "in-between" pointer for strings
        var dptr = new FFI.Pointer(FFI.Bindings.TYPE_SIZE_MAP["pointer"]);
        dptr.putPointer(ptr);
        return dptr;
    }
    else {
        return ptr;
    }
    
};

FFI.Internal.extractValue = function(type, ptr) {
    var dptr = ptr;
    
    if (type == "string") {
        dptr = ptr.getPointer();
        if (dptr.isNull()) {
            throw "Attempted to dereference null string/pointer";
        }
    }
    
    return dptr["get" + FFI.TYPE_TO_POINTER_METHOD_MAP[type]]();
};

FFI.Internal.methodFactory = function(ptr, returnType, types) {
    var bareMethod = FFI.Internal.bareMethodFactory(ptr, returnType, types);
    
    return function() {
        var args = [];
        
        for (var i = 0; i < types.length; i++) {
            args[i] = FFI.Internal.buildValue(types[i], arguments[i]);
        }
        
        return FFI.Internal.extractValue(returnType, bareMethod(args));
    };
};

FFI.DynamicLibrary = function(path, mode) {
    this._handle = this._dlopen(path, mode);
    
    if (this._handle.isNull()) {
        sys.puts(this._dlerror());
        throw "Dynamic Linking Error";
    }
};

FFI.DynamicLibrary.FLAGS = {
    "RTLD_LAZY":    0x1,
    "RTLD_NOW":     0x2,
    "RTLD_LOCAL":   0x4,
    "RTLD_GLOBAL":  0x8
};

FFI.DynamicLibrary.prototype._dlopen = FFI.Internal.methodFactory(
    FFI.StaticFunctions.dlopen,
    "pointer",
    [ "string", "sint32" ]
);

FFI.DynamicLibrary.prototype._dlclose = FFI.Internal.methodFactory(
    FFI.StaticFunctions.dlclose,
    "sint32",
    [ "pointer" ]
);

FFI.DynamicLibrary.prototype._dlsym = FFI.Internal.methodFactory(
    FFI.StaticFunctions.dlsym,
    "pointer",
    [ "pointer", "string" ]
);

FFI.DynamicLibrary.prototype._dlerror = FFI.Internal.methodFactory (
    FFI.StaticFunctions.dlerror,
    "string",
    [ ]
);

FFI.DynamicLibrary.prototype.close = function() {
    return this._dlclose(this._handle);
};

FFI.DynamicLibrary.prototype.get = function(symbol) {
    var ptr;

    if ((ptr = this._dlsym(this._handle, symbol)).isNull()) {
        sys.puts(this.error());
        throw this.error();
    }

    return ptr;
};

FFI.DynamicLibrary.prototype.error = function() {
    return this._dlerror();
};

exports.Internal = FFI.Internal;
exports.StructType = FFI.StructType;
exports.DynamicLibrary = FFI.DynamicLibrary;